/**
 * Unit tests for jest globalSetup safety guards (#3476).
 *
 * The globalSetup runs BEFORE any test suite, so its own behaviour can't be
 * observed from inside a test. These tests exercise the module as a plain
 * async function — the same entry point jest uses — while mocking mongoose
 * and config to avoid touching a real database.
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
    process.env.NODE_ENV = originalNodeEnv;
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

    expect(connect).toHaveBeenCalledWith('mongodb://localhost:27017/NodeTest');
    expect(dropDatabase).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('swallows errors when MongoDB is unreachable', async () => {
    process.env.NODE_ENV = 'test';
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    jest.unstable_mockModule('../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://localhost:27017/NodeTest' } },
    }));
    const { default: globalSetup } = await import('../jest.globalSetup.js');

    await expect(globalSetup()).resolves.toBeUndefined();
    expect(dropDatabase).not.toHaveBeenCalled();
  });
});
