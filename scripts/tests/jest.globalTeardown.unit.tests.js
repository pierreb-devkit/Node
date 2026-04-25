/**
 * Unit tests for jest globalTeardown safety guards (#3515).
 *
 * Mirrors the globalSetup contract: refuse to drop when NODE_ENV is not
 * "test" or when the resolved DB name does not match /test/i, swallow
 * connection errors, and always disconnect even when dropDatabase fails.
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

describe('scripts/jest.globalTeardown safety guards', () => {
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
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
  });

  test('refuses to drop when NODE_ENV is not "test"', async () => {
    process.env.NODE_ENV = 'ism';
    const { default: globalTeardown } = await import('../jest.globalTeardown.js');

    await globalTeardown();

    expect(connect).not.toHaveBeenCalled();
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is "ism"'));
  });

  test('refuses to drop when resolved DB name does not contain "test"', async () => {
    process.env.NODE_ENV = 'test';
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/ProductionDb' } },
    }));
    const { default: globalTeardown } = await import('../jest.globalTeardown.js');

    await globalTeardown();

    expect(connect).not.toHaveBeenCalled();
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Refusing to drop "ProductionDb"'));
  });

  test('drops the per-pid DB resolved from config (no hardcoded NodeTest)', async () => {
    process.env.NODE_ENV = 'test';
    const perPidUri = `mongodb://localhost:27017/NodeTest_${process.pid}`;
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: perPidUri } },
    }));
    const { default: globalTeardown } = await import('../jest.globalTeardown.js');

    await globalTeardown();

    // Critical: teardown must use the resolved URI, not a hardcoded string —
    // otherwise per-pid orphan DBs would accumulate forever.
    expect(connect).toHaveBeenCalledWith(perPidUri);
    expect(dropDatabase).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('swallows errors when MongoDB is unreachable (no failed exit code)', async () => {
    process.env.NODE_ENV = 'test';
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest_999' } },
    }));
    const { default: globalTeardown } = await import('../jest.globalTeardown.js');

    await expect(globalTeardown()).resolves.toBeUndefined();
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipped drop'));
  });

  test('disconnects even when dropDatabase() fails (no dangling connection)', async () => {
    process.env.NODE_ENV = 'test';
    dropDatabase.mockRejectedValueOnce(new Error('drop failed'));
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest_42' } },
    }));
    const { default: globalTeardown } = await import('../jest.globalTeardown.js');

    await expect(globalTeardown()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(dropDatabase).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
