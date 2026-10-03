/**
 * Module dependencies.
 */
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';
import { acquireLock, releaseLock, CronLock } from '../../../lib/services/distributedLock.js';

/**
 * Integration tests for `users.emailSequences.js`'s lock usage (#4163) —
 * real MongoDB. The shared `acquireLock`/`releaseLock` contract itself is
 * already exhaustively covered by `lib/services/tests/distributedLock.unit.tests.js`
 * and exercised again per-cron-name in `modules/billing/tests/billing.cron-lock.integration.tests.js`;
 * this file follows that same precedent for this cron's own lock name/TTL
 * rather than re-deriving the primitive's behavior.
 */
describe('users.emailSequences cron lock — acquire / release contract:', () => {
  const LOCK_NAME = 'users.emailSequences';

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
  });

  beforeEach(async () => {
    await CronLock.deleteMany({});
  });

  afterAll(async () => {
    await CronLock.deleteMany({});
    await mongooseService.disconnect();
  });

  test('acquires the lock on an empty collection', async () => {
    const ok = await acquireLock({ name: LOCK_NAME, ttlMs: 15 * 60 * 1000, holder: 'pod-1' });
    expect(ok).toBe(true);

    const doc = await CronLock.findById(LOCK_NAME);
    expect(doc).not.toBeNull();
    expect(doc.holder).toBe('pod-1');
  });

  test('a second pod is rejected while the lock is held — the run is skipped, not duplicated', async () => {
    await acquireLock({ name: LOCK_NAME, ttlMs: 15 * 60 * 1000, holder: 'pod-1' });
    const ok = await acquireLock({ name: LOCK_NAME, ttlMs: 15 * 60 * 1000, holder: 'pod-2' });
    expect(ok).toBe(false);
  });

  test('releaseLock only removes the doc when the holder matches', async () => {
    await acquireLock({ name: LOCK_NAME, ttlMs: 15 * 60 * 1000, holder: 'pod-1' });

    await releaseLock({ name: LOCK_NAME, holder: 'pod-2' });
    expect(await CronLock.findById(LOCK_NAME)).not.toBeNull();

    await releaseLock({ name: LOCK_NAME, holder: 'pod-1' });
    expect(await CronLock.findById(LOCK_NAME)).toBeNull();
  });

  test('an expired lock (lockedUntil in the past) can be re-acquired by another pod', async () => {
    await CronLock.create({
      _id: LOCK_NAME,
      lockedAt: new Date(Date.now() - 20 * 60 * 1000),
      lockedUntil: new Date(Date.now() - 5 * 60 * 1000),
      holder: 'stale-pod',
    });

    const ok = await acquireLock({ name: LOCK_NAME, ttlMs: 15 * 60 * 1000, holder: 'pod-2' });
    expect(ok).toBe(true);
  });
});
