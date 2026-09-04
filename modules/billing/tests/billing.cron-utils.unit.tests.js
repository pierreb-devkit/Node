/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

describe('billing cron utils:', () => {
  let randomInt;
  let applyJitter;

  beforeEach(async () => {
    jest.resetModules();
    randomInt = jest.fn().mockReturnValue(0);
    jest.unstable_mockModule('node:crypto', () => ({ randomInt }));
    ({ applyJitter } = await import('../lib/billing.cron-utils.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('applyJitter uses crypto randomInt with configured max', async () => {
    const slept = await applyJitter(1234);

    expect(randomInt).toHaveBeenCalledWith(0, 1234);
    expect(slept).toBe(0);
  });

  test('applyJitter skips invalid or disabled jitter', async () => {
    await expect(applyJitter(0)).resolves.toBe(0);
    await expect(applyJitter(Infinity)).resolves.toBe(0);
    expect(randomInt).not.toHaveBeenCalled();
  });
});

describe('billing cron utils — bootstrapCron:', () => {
  let bootstrapCron;
  let mockConfig;
  let mockLogger;
  let mockMongooseService;
  let mockAcquireLock;
  let mockReleaseLock;
  let exitSpy;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.NODE_ENV;

    mockConfig = { billing: { meterMode: true, referral: { enabled: false } } };
    mockLogger = { info: jest.fn(), error: jest.fn() };
    mockMongooseService = { loadModels: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
    mockAcquireLock = jest.fn();
    mockReleaseLock = jest.fn();

    // Same resolved targets the crons themselves hit (config/services/distributedLock sit
    // 3 levels above modules/billing/{lib,tests}/ alike — mongoose.js/logger.js/
    // distributedLock.js resolve identically from either sibling dir). billing.constants.js
    // is deliberately NOT mocked — its real named exports are what proves the "everything
    // else each cron currently destructures" contract (e.g. getDunningThresholdDays).
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/mongoose.js', () => ({ default: mockMongooseService }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../lib/services/distributedLock.js', () => ({
      acquireLock: mockAcquireLock,
      releaseLock: mockReleaseLock,
    }));

    ({ bootstrapCron } = await import('../lib/billing.cron-utils.js'));

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('defaults NODE_ENV to development when unset', async () => {
    await bootstrapCron({
      isEnabled: () => true,
      gateMessage: 'unused',
      lockName: 'billing.probe',
      lockTtlMs: 1000,
    });

    expect(process.env.NODE_ENV).toBe('development');
  });

  test('leaves an explicit NODE_ENV untouched', async () => {
    process.env.NODE_ENV = 'test';

    await bootstrapCron({
      isEnabled: () => true,
      gateMessage: 'unused',
      lockName: 'billing.probe',
      lockTtlMs: 1000,
    });

    expect(process.env.NODE_ENV).toBe('test');
  });

  test('closed gate logs gateMessage and exits 0 without acquiring any lock', async () => {
    const result = await bootstrapCron({
      isEnabled: () => false,
      gateMessage: '[cron.probe] disabled — skipping.',
      lockName: 'billing.probe',
      lockTtlMs: 1000,
    });

    expect(mockLogger.info).toHaveBeenCalledWith('[cron.probe] disabled — skipping.');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('open gate returns every binding a cron currently destructures, plus the echoed lock params', async () => {
    const result = await bootstrapCron({
      isEnabled: (config) => Boolean(config?.billing?.meterMode),
      gateMessage: 'unused',
      lockName: 'billing.dunningSweep',
      lockTtlMs: 15 * 60 * 1000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.config).toBe(mockConfig);
    expect(result.mongooseService).toBe(mockMongooseService);
    expect(result.logger).toBe(mockLogger);
    expect(result.acquireLock).toBe(mockAcquireLock);
    expect(result.releaseLock).toBe(mockReleaseLock);
    expect(result.LOCK_NAME).toBe('billing.dunningSweep');
    expect(result.LOCK_TTL_MS).toBe(15 * 60 * 1000);
    expect(typeof result.applyJitter).toBe('function');
    // Real billing.constants.js exports — proves the spread carries every constant,
    // not a hardcoded subset (the trap: dunningSweep alone also needs this one).
    expect(typeof result.getCronJitterMaxMs).toBe('function');
    expect(typeof result.getDunningThresholdDays).toBe('function');
    expect(result.getDunningThresholdDays()).toBe(14); // DEFAULT_DUNNING_THRESHOLD_DAYS
  });

  test('gate predicate receives the loaded config — referral gate is independent of meterMode', async () => {
    mockConfig.billing.meterMode = false;
    mockConfig.billing.referral.enabled = true;

    const result = await bootstrapCron({
      isEnabled: (config) => Boolean(config?.billing?.referral?.enabled),
      gateMessage: 'unused',
      lockName: 'billing.referralReconcile',
      lockTtlMs: 10 * 60 * 1000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.LOCK_NAME).toBe('billing.referralReconcile');
  });
});
