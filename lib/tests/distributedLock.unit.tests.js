/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for lib/distributedLock.js
 *
 * All Mongoose interactions are mocked — no real DB connection required.
 * Tests verify the acquire / release contract and contention handling.
 */
describe('distributedLock — acquireLock:', () => {
  let acquireLock;
  let mockFindOneAndUpdate;
  let mockDeleteOne;

  beforeEach(async () => {
    jest.resetModules();

    mockFindOneAndUpdate = jest.fn();
    mockDeleteOne = jest.fn();

    const mockCronLock = {
      findOneAndUpdate: mockFindOneAndUpdate,
      deleteOne: mockDeleteOne,
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Schema: class MockSchema {
          constructor() {}
          index() {}
        },
        models: {},
        model: jest.fn(() => mockCronLock),
      },
    }));

    ({ acquireLock } = await import('../distributedLock.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns true when findOneAndUpdate resolves with matching holder', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1' });

    const ok = await acquireLock({ name: 'job-a', ttlMs: 60_000, holder: 'pod-1' });

    expect(ok).toBe(true);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('job-a');
    expect(filter.lockedUntil.$lt).toBeInstanceOf(Date);
    expect(update.$set.holder).toBe('pod-1');
    expect(opts.upsert).toBe(true);
  });

  test('returns false when findOneAndUpdate returns doc held by different holder', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1' });

    const ok = await acquireLock({ name: 'job-b', ttlMs: 60_000, holder: 'pod-2' });

    expect(ok).toBe(false);
  });

  test('returns false on E11000 duplicate-key (concurrent upsert race)', async () => {
    const dupErr = new Error('E11000 duplicate key');
    dupErr.code = 11000;
    mockFindOneAndUpdate.mockRejectedValue(dupErr);

    const ok = await acquireLock({ name: 'job-c', ttlMs: 60_000, holder: 'pod-1' });

    expect(ok).toBe(false);
  });

  test('re-throws non-duplicate errors', async () => {
    const dbErr = new Error('network timeout');
    dbErr.code = 13;
    mockFindOneAndUpdate.mockRejectedValue(dbErr);

    await expect(acquireLock({ name: 'job-d', ttlMs: 60_000, holder: 'pod-1' })).rejects.toThrow('network timeout');
  });

  test('lockedUntil is set to now + ttlMs', async () => {
    const before = Date.now();
    mockFindOneAndUpdate.mockResolvedValue({ holder: 'pod-1' });

    await acquireLock({ name: 'job-e', ttlMs: 10_000, holder: 'pod-1' });

    const after = Date.now();
    const { lockedUntil } = mockFindOneAndUpdate.mock.calls[0][1].$set;
    expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(lockedUntil.getTime()).toBeLessThanOrEqual(after + 10_000);
  });
});

describe('distributedLock — releaseLock:', () => {
  let releaseLock;
  let mockDeleteOne;

  beforeEach(async () => {
    jest.resetModules();

    mockDeleteOne = jest.fn().mockResolvedValue({});

    const mockCronLock = {
      findOneAndUpdate: jest.fn(),
      deleteOne: mockDeleteOne,
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Schema: class MockSchema {
          constructor() {}
          index() {}
        },
        models: {},
        model: jest.fn(() => mockCronLock),
      },
    }));

    ({ releaseLock } = await import('../distributedLock.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('calls deleteOne with name and holder', async () => {
    await releaseLock({ name: 'job-a', holder: 'pod-1' });

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'job-a', holder: 'pod-1' });
  });

  test('does not throw when deleteOne resolves', async () => {
    await expect(releaseLock({ name: 'job-b', holder: 'pod-2' })).resolves.toBeUndefined();
  });

  test('propagates deleteOne errors to the caller', async () => {
    const dbErr = new Error('network timeout');
    mockDeleteOne.mockRejectedValue(dbErr);
    await expect(releaseLock({ name: 'job-c', holder: 'pod-1' })).rejects.toThrow('network timeout');
  });
});
