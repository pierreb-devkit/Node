/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests — #3990. `mongoose.connect()` resolving does not mean indexes
 * exist yet (autoIndex builds run in the background). `awaitIndexBuilds()`
 * must call `Model#init()` on every currently registered model and only
 * resolve once ALL of those builds finish — and it must propagate (not
 * swallow) a rejection from any one of them, since that is exactly how an
 * invalid index declaration (e.g. an unsupported partialFilterExpression
 * operator) is surfaced instead of silently never building.
 *
 * Follow-up (#3990 review — unbounded boot block): `awaitIndexBuilds()` is
 * now bounded by `config.db.awaitIndexBuilds`. On a timeout it must CONTINUE
 * (not hang, not throw) and log a loud warning naming the still-building
 * model(s); `config.db.awaitIndexBuilds === false` must skip the wait
 * entirely. Those two paths need their own config mock (a non-default
 * `db.awaitIndexBuilds`), so they set up their own isolated module registry
 * rather than reusing the shared `beforeEach` below.
 */
describe('mongoose service — awaitIndexBuilds:', () => {
  let mongoose;
  let awaitIndexBuilds;

  beforeEach(async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {} }, files: { mongooseModels: [] } },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    mongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn(() => ({ init: jest.fn().mockResolvedValue(undefined) })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: mongoose }));

    const mod = await import('../mongoose.js');
    awaitIndexBuilds = mod.default.awaitIndexBuilds;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('calls init() on every currently registered model', async () => {
    await awaitIndexBuilds();
    expect(mongoose.modelNames).toHaveBeenCalled();
    expect(mongoose.model).toHaveBeenCalledWith('User');
    expect(mongoose.model).toHaveBeenCalledWith('BillingUsage');
  });

  test('resolves only after every model init() promise settles', async () => {
    let userResolved = false;
    let billingResolved = false;
    mongoose.model = jest.fn((name) => ({
      init: jest.fn(() =>
        new Promise((resolve) => {
          setTimeout(() => {
            if (name === 'User') userResolved = true;
            if (name === 'BillingUsage') billingResolved = true;
            resolve(undefined);
          }, 5);
        }),
      ),
    }));

    await awaitIndexBuilds();
    expect(userResolved).toBe(true);
    expect(billingResolved).toBe(true);
  });

  test('propagates a model init() rejection instead of swallowing it (e.g. an invalid index declaration)', async () => {
    mongoose.model = jest.fn((name) => ({
      init:
        name === 'BillingUsage'
          ? jest.fn().mockRejectedValue(new Error('unsupported partial filter operator'))
          : jest.fn().mockResolvedValue(undefined),
    }));

    await expect(awaitIndexBuilds()).rejects.toThrow('unsupported partial filter operator');
  });

  test('resolves with no models registered (nothing to await)', async () => {
    mongoose.modelNames = jest.fn(() => []);
    await expect(awaitIndexBuilds()).resolves.toBeUndefined();
    expect(mongoose.model).not.toHaveBeenCalled();
  });

  test('continues boot after the configured timeout, logging the still-building model(s)', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {}, awaitIndexBuilds: { timeoutMs: 15 } },
        files: { mongooseModels: [] },
      },
    }));
    const warn = jest.fn();
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn },
    }));

    let resolveBillingInit;
    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn((name) => ({
        init:
          name === 'BillingUsage'
            // Never settles within the 15ms timeout — simulates a
            // still-in-flight build on a big collection.
            ? jest.fn(() => new Promise((resolve) => { resolveBillingInit = resolve; }))
            : jest.fn().mockResolvedValue(undefined),
      })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    await expect(mod.default.awaitIndexBuilds()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining('BillingUsage'));
    expect(warn.mock.calls[0][0]).not.toEqual(expect.stringContaining(': User'));

    // Let the deferred build settle so it doesn't leak into later tests.
    resolveBillingInit(undefined);
  });

  test('honors a numeric-STRING timeoutMs (a Layer-4 DEVKIT_NODE_* env override always arrives as a string, never a number)', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {}, awaitIndexBuilds: { timeoutMs: '15' } },
        files: { mongooseModels: [] },
      },
    }));
    const warn = jest.fn();
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn },
    }));

    let resolveBillingInit;
    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn((name) => ({
        init:
          name === 'BillingUsage'
            // Never settles within the 15ms string-typed timeout.
            ? jest.fn(() => new Promise((resolve) => { resolveBillingInit = resolve; }))
            : jest.fn().mockResolvedValue(undefined),
      })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    await expect(mod.default.awaitIndexBuilds()).resolves.toBeUndefined();

    // If '15' (string) were rejected by Number.isFinite as pre-fix, the
    // DEFAULT (60000ms) would apply instead and this warn would never fire
    // within the test's lifetime.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining('BillingUsage'));

    resolveBillingInit(undefined);
  });

  test('falls back to the default timeout on a non-positive/non-numeric timeoutMs override', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        // Malformed overrides must not race straight to a ~0ms timeout.
        db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {}, awaitIndexBuilds: { timeoutMs: '-5' } },
        files: { mongooseModels: [] },
      },
    }));
    const warn = jest.fn();
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn },
    }));

    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn(() => ({
        // Resolves quickly (5ms) — if the invalid override fell through to a
        // ~0ms timeout instead of the 60000ms default, the timeout promise
        // would win the race and warn() would fire.
        init: jest.fn(() => new Promise((resolve) => { setTimeout(() => resolve(undefined), 5); })),
      })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    await expect(mod.default.awaitIndexBuilds()).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });

  test('config.db.awaitIndexBuilds === false skips the wait entirely', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {}, awaitIndexBuilds: false },
        files: { mongooseModels: [] },
      },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn(() => ({ init: jest.fn().mockResolvedValue(undefined) })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    await expect(mod.default.awaitIndexBuilds()).resolves.toBeUndefined();

    expect(localMongoose.modelNames).not.toHaveBeenCalled();
    expect(localMongoose.model).not.toHaveBeenCalled();
  });
});
