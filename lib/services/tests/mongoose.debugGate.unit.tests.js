/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — mongoose query debug logging must be enabled ONLY in dev-grade envs
 * (development/test/local). Under any production-grade env (the literal `production`
 * OR a deployment env label) query logging must never run, even if config.db.debug
 * is truthy. Closes the env-gate defect where verbose query logging could leak
 * collection/field/value detail into downstream production logs.
 */
describe('mongoose service — debug env gate:', () => {
  let originalNodeEnv;
  let resolveDebug;

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', debug: true, options: {} }, files: { mongooseModels: [] } },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));
    const mod = await import('../mongoose.js');
    resolveDebug = mod.default.resolveDebug;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  test('debug stays ENABLED in development when config.db.debug is true', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveDebug({ db: { debug: true } })).toBe(true);
  });

  test('debug stays ENABLED in test when config.db.debug is true', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveDebug({ db: { debug: true } })).toBe(true);
  });

  test('debug is DISABLED under a project (non-dev) env even when config.db.debug is true', () => {
    process.env.NODE_ENV = 'someproject';
    expect(resolveDebug({ db: { debug: true } })).toBe(false);
  });

  test('debug is DISABLED under the literal production env even when config.db.debug is true', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveDebug({ db: { debug: true } })).toBe(false);
  });

  test('debug is DISABLED in development when config.db.debug is false', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveDebug({ db: { debug: false } })).toBe(false);
  });
});
