import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

describe('logger.error → PostHog $exception (integration):', () => {
  let logger;
  let mockPostHogInstance;

  beforeEach(async () => {
    jest.resetModules();
    mockPostHogInstance = {
      capture: jest.fn(),
      captureException: jest.fn(),
      identify: jest.fn(),
      groupIdentify: jest.fn(),
      getFeatureFlag: jest.fn().mockResolvedValue(undefined),
      isFeatureEnabled: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    jest.unstable_mockModule('posthog-node', () => ({
      PostHog: jest.fn().mockImplementation(() => mockPostHogInstance),
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        analytics: { posthog: { enabled: true, key: 'phc_test', host: 'https://eu.i.posthog.com', errorTracking: true, appTag: 'devkit' } },
        logger: { level: 'info' },
        log: { level: 'info', fileLogger: {} },
      },
    }));

    const analyticsMod = await import('../analytics.js');
    await analyticsMod.default.init();
    const loggerMod = await import('../logger.js');
    logger = loggerMod.default ?? loggerMod.logger;
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('logger.error(message, { error }) emits a single $exception event via SDK captureException', () => {
    const err = new Error('payment failed');
    logger.error('Charge failed for user', { error: err });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({
        logMessage: 'Charge failed for user',
        logLevel: 'error',
        source: 'system',
      }),
    );
  });

  test('logger.error(err) directly emits a single $exception event via SDK captureException', () => {
    const err = new Error('boom');
    logger.error(err);
    expect(mockPostHogInstance.captureException).toHaveBeenCalledTimes(1);
  });

  test('error already marked posthogCaptured does NOT re-emit', () => {
    const err = Object.assign(new Error('boom'), { posthogCaptured: true });
    logger.error('skipped', { error: err });
    expect(mockPostHogInstance.captureException).not.toHaveBeenCalled();
  });
});
