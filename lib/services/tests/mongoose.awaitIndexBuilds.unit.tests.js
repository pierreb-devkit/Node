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

  /**
   * #4004 — a schema-declared index whose options differ from a PRE-EXISTING
   * same-name index (MongoDB codes 85 IndexOptionsConflict / 86
   * IndexKeySpecsConflict) must NOT fail startup: the migration that
   * reconciles the conflict runs AFTER awaitIndexBuilds() in bootstrap, so
   * rejecting here gates the repair behind the very defect it repairs. The
   * conflict must instead be logged at error level, naming the model and both
   * the declared (schema) and live (collection) specs. Every other rejection
   * keeps propagating (covered above). These paths need their own logger mock
   * (to capture error calls), so they set up an isolated module registry like
   * the timeout tests.
   * @param {object} opts - scenario configuration
   * @param {Error} opts.initError - rejection reason for the `BillingUsage` model's `init()`
   * @param {Function} opts.listIndexes - mock `toArray()` implementation for `collection.listIndexes()`
   * @returns {Promise<{awaitIndexBuilds: Function, error: import('@jest/globals').Mock}>} the isolated
   *  `awaitIndexBuilds` under test and the mocked `logger.error`
   */
  const setupWithConflictingModel = async ({ initError, listIndexes }) => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {} }, files: { mongooseModels: [] } },
    }));
    const error = jest.fn();
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error, warn: jest.fn() },
    }));

    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn((name) => ({
        init: name === 'BillingUsage' ? jest.fn().mockRejectedValue(initError) : jest.fn().mockResolvedValue(undefined),
        schema: {
          indexes: jest.fn(() => [
            [{ organizationId: 1, month: 1 }, { unique: true, partialFilterExpression: { legacyPeriod: { $exists: true } } }],
          ]),
        },
        collection: { listIndexes: jest.fn(() => ({ toArray: listIndexes })) },
      })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    return { awaitIndexBuilds: mod.default.awaitIndexBuilds, error };
  };

  test('same-name index conflict (code 85, IndexOptionsConflict) does NOT reject — boot continues, error names model + both specs', async () => {
    const conflict = Object.assign(new Error('An existing index has the same name as the requested index.'), {
      code: 85,
      codeName: 'IndexOptionsConflict',
    });
    const { awaitIndexBuilds: run, error } = await setupWithConflictingModel({
      initError: conflict,
      listIndexes: jest.fn().mockResolvedValue([{ v: 2, key: { organizationId: 1, month: 1 }, name: 'organizationId_1_month_1', unique: true }]),
    });

    await expect(run()).resolves.toBeUndefined();

    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toEqual(expect.stringContaining('BillingUsage'));
    expect(logged).toEqual(expect.stringContaining('IndexOptionsConflict'));
    expect(logged).toEqual(expect.stringContaining('declared (schema)'));
    expect(logged).toEqual(expect.stringContaining('partialFilterExpression'));
    expect(logged).toEqual(expect.stringContaining('live (collection)'));
    expect(logged).toEqual(expect.stringContaining('organizationId_1_month_1'));
  });

  test('same-name key-spec conflict identified by codeName only (IndexKeySpecsConflict, no numeric code) is tolerated too', async () => {
    const conflict = Object.assign(new Error('Index must have unique name.'), { codeName: 'IndexKeySpecsConflict' });
    const { awaitIndexBuilds: run, error } = await setupWithConflictingModel({
      initError: conflict,
      listIndexes: jest.fn().mockResolvedValue([]),
    });

    await expect(run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  test('conflict tolerance survives a failing spec enumeration (listIndexes throws) — still resolves, still logs', async () => {
    const conflict = Object.assign(new Error('An existing index has the same name as the requested index.'), { code: 85 });
    const { awaitIndexBuilds: run, error } = await setupWithConflictingModel({
      initError: conflict,
      listIndexes: jest.fn().mockRejectedValue(new Error('not authorized on listIndexes')),
    });

    await expect(run()).resolves.toBeUndefined();
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toEqual(expect.stringContaining('could not enumerate declared/live index specs'));
  });

  test('tolerance is scoped to conflicts: a non-conflict rejection on another model still propagates', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { db: { uri: 'mongodb://127.0.0.1:27017/NodeTest', options: {} }, files: { mongooseModels: [] } },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    const conflict = Object.assign(new Error('An existing index has the same name as the requested index.'), { code: 85 });
    const localMongoose = {
      modelNames: jest.fn(() => ['User', 'BillingUsage']),
      model: jest.fn((name) => ({
        init:
          name === 'BillingUsage'
            ? jest.fn().mockRejectedValue(conflict)
            : jest.fn().mockRejectedValue(new Error('unsupported partial filter operator')),
        schema: { indexes: jest.fn(() => []) },
        collection: { listIndexes: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })) },
      })),
      connect: jest.fn(),
      set: jest.fn(),
    };
    jest.unstable_mockModule('mongoose', () => ({ default: localMongoose }));

    const mod = await import('../mongoose.js');
    await expect(mod.default.awaitIndexBuilds()).rejects.toThrow('unsupported partial filter operator');
  });
});
