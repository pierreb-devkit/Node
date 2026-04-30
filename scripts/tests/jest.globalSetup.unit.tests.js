/**
 * Unit tests for jest globalSetup safety guards (#3476).
 *
 * The globalSetup runs BEFORE any test suite, so its own behaviour can't be
 * observed from inside a test. These tests exercise the module as a plain
 * async function — the same entry point jest uses — while mocking mongoose
 * and config to avoid touching a real database.
 *
 * globalSetup has two sequential phases:
 *  Phase 1: connect → dropDatabase → disconnect (DB drop)
 *  Phase 2: connect → loadModels → migrations.run → disconnect (migrations pre-run)
 * Phase 2 uses a try/catch so failures are swallowed — tests that mock config
 * without `files.mongooseModels` will silently skip the migrations phase.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const connect = jest.fn(async () => {});
const dropDatabase = jest.fn(async () => {});
const disconnect = jest.fn(async () => {});

jest.unstable_mockModule('mongoose', () => ({
  default: {
    connect,
    disconnect,
    connection: { dropDatabase },
  },
}));

describe('scripts/jest.globalSetup safety guards', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warnSpy;

  beforeEach(() => {
    connect.mockClear();
    dropDatabase.mockClear();
    disconnect.mockClear();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // Restore the original NODE_ENV — `process.env` coerces values to strings,
    // so assigning `undefined` would leave the literal string "undefined". Use
    // `delete` when the variable was originally absent.
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
  });

  test('refuses to drop when NODE_ENV is not "test" (project env leak)', async () => {
    process.env.NODE_ENV = 'ism';
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await globalSetup();

    expect(connect).not.toHaveBeenCalled();
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is "ism"'));
  });

  test('refuses to drop when NODE_ENV is undefined', async () => {
    delete process.env.NODE_ENV;
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await globalSetup();

    expect(dropDatabase).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is "undefined"'));
  });

  test('refuses to drop when resolved DB name does not contain "test"', async () => {
    process.env.NODE_ENV = 'test';
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/ProductionDb' } },
    }));
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await globalSetup();

    expect(connect).not.toHaveBeenCalled();
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Refusing to drop "ProductionDb"'));
  });

  test('drops database when NODE_ENV=test and DB name contains "test" (case-insensitive)', async () => {
    process.env.NODE_ENV = 'test';
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest' } },
    }));
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await globalSetup();

    // Phase 1 (drop): connect → dropDatabase → disconnect
    expect(connect).toHaveBeenCalledWith('mongodb://localhost:27017/NodeTest');
    expect(dropDatabase).toHaveBeenCalledTimes(1);
    // Phase 2 (migrations): connects again; config.files absent → swallowed, but
    // disconnect is still called via the finally block
    // Minimum: both phases connected + disconnected at least once each
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('swallows errors when MongoDB is unreachable', async () => {
    process.env.NODE_ENV = 'test';
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest' } },
    }));
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await expect(globalSetup()).resolves.toBeUndefined();
    // Phase 1 connect threw → dropDatabase never reached
    expect(dropDatabase).not.toHaveBeenCalled();
    // Phase 2 still tries to connect (second call succeeds)
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('disconnects even when dropDatabase() fails (no dangling connection)', async () => {
    process.env.NODE_ENV = 'test';
    dropDatabase.mockRejectedValueOnce(new Error('drop failed'));
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest' } },
    }));
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await expect(globalSetup()).resolves.toBeUndefined();
    // Phase 1: dropDatabase failed but disconnect is always called (finally block)
    expect(dropDatabase).toHaveBeenCalledTimes(1);
    // Both phases call disconnect via finally blocks — no dangling connections
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
