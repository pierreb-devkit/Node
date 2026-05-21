/**
 * Module dependencies.
 */
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';
import { acquireLock, releaseLock, CronLock } from '../../../lib/distributedLock.js';

/**
 * Integration tests for lib/distributedLock.js — real MongoDB.
 *
 * Verifies the acquire / release / contention / expiry contract end-to-end.
 * The cron scripts themselves are top-level-await CLI entry points that cannot
 * be imported in tests; the lock primitive they delegate to is tested here.
 */
describe('distributedLock integration — acquire / release contract:', () => {
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

  test('acquires lock when collection is empty', async () => {
    const ok = await acquireLock({ name: 'billing.weeklyReset', ttlMs: 60_000, holder: 'pod-1' });
    expect(ok).toBe(true);

    const doc = await CronLock.findById('billing.weeklyReset');
    expect(doc).not.toBeNull();
    expect(doc.holder).toBe('pod-1');
  });

  test('rejects acquire when lock is held by another holder', async () => {
    await acquireLock({ name: 'billing.dunningSweep', ttlMs: 60_000, holder: 'pod-1' });
    const ok = await acquireLock({ name: 'billing.dunningSweep', ttlMs: 60_000, holder: 'pod-2' });
    expect(ok).toBe(false);
  });

  test('allows acquire when previous lock has expired (ttlMs < 0)', async () => {
    // Seed an already-expired lock: lockedUntil in the past
    await CronLock.create({
      _id: 'billing.extrasExpiration',
      lockedAt: new Date(Date.now() - 10_000),
      lockedUntil: new Date(Date.now() - 5_000),
      holder: 'old-pod',
    });

    const ok = await acquireLock({ name: 'billing.extrasExpiration', ttlMs: 60_000, holder: 'pod-2' });
    expect(ok).toBe(true);
  });

  test('releaseLock removes doc only when holder matches', async () => {
    await acquireLock({ name: 'billing.weeklyReset', ttlMs: 60_000, holder: 'pod-1' });

    // Wrong holder — lock should remain
    await releaseLock({ name: 'billing.weeklyReset', holder: 'pod-2' });
    const stillHeld = await CronLock.findById('billing.weeklyReset');
    expect(stillHeld).not.toBeNull();
    expect(stillHeld.holder).toBe('pod-1');

    // Correct holder — lock released
    await releaseLock({ name: 'billing.weeklyReset', holder: 'pod-1' });
    const gone = await CronLock.findById('billing.weeklyReset');
    expect(gone).toBeNull();
  });

  test('concurrent acquires: only one pod wins (Promise.all race)', async () => {
    const results = await Promise.all([
      acquireLock({ name: 'billing.dunningSweep', ttlMs: 60_000, holder: 'pod-A' }),
      acquireLock({ name: 'billing.dunningSweep', ttlMs: 60_000, holder: 'pod-B' }),
      acquireLock({ name: 'billing.dunningSweep', ttlMs: 60_000, holder: 'pod-C' }),
    ]);

    const wins = results.filter(Boolean);
    expect(wins).toHaveLength(1);

    const doc = await CronLock.findById('billing.dunningSweep');
    expect(doc).not.toBeNull();
    // The winning holder is one of the three
    expect(['pod-A', 'pod-B', 'pod-C']).toContain(doc.holder);
  });

  test('acquire sets correct TTL window', async () => {
    const before = Date.now();
    await acquireLock({ name: 'billing.extrasExpiration', ttlMs: 5 * 60 * 1000, holder: 'pod-1' });
    const after = Date.now();

    const doc = await CronLock.findById('billing.extrasExpiration');
    expect(doc.lockedUntil.getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    expect(doc.lockedUntil.getTime()).toBeLessThanOrEqual(after + 5 * 60 * 1000);
  });
});
