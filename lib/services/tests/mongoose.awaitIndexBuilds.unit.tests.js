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
    await expect(awaitIndexBuilds()).resolves.toEqual([]);
    expect(mongoose.model).not.toHaveBeenCalled();
  });
});
