/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, afterEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * #3990 — `mongoose.connect()` resolving does not mean indexes exist: autoIndex
 * builds run in the background and the old `startMongoose()` never awaited them.
 * On a brand-new database the first writes could land inside that build window,
 * turning BillingUsage's unique-index idempotency guards into a no-op — a
 * duplicate upsert would create a SECOND document instead of hitting E11000.
 *
 * `Model#init()` (what `mongooseService.awaitIndexBuilds()` calls) caches its
 * promise per model per connection — mongoose already calls it once
 * automatically when a model is compiled, so a SECOND explicit call is a no-op
 * rather than a genuine rebuild. That is exactly the real boot semantics (one
 * connection, one index-build pass, before anything else runs), so this suite
 * exercises it the same way: `beforeAll` drives the REAL boot path once
 * (`loadModels -> connect -> awaitIndexBuilds`, the same sequence `lib/app.js
 * #startMongoose` now runs), and every test below relies on that single,
 * already-awaited end state — proving that once boot has resolved, nothing can
 * observe a window where the unique indexes are not yet built.
 */
describe('BillingUsage — boot-time index readiness (#3990):', () => {
  let BillingUsageRepository;
  let collection;
  const trackedOrgIds = [];

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    // The same call lib/app.js#startMongoose now makes before reporting ready.
    await mongooseService.awaitIndexBuilds();
    collection = mongoose.connection.db.collection('billingusages');
    BillingUsageRepository = (await import('../repositories/billing.usage.repository.js')).default;
  });

  afterEach(async () => {
    if (trackedOrgIds.length > 0) {
      await collection.deleteMany({ organizationId: { $in: trackedOrgIds.splice(0) } });
    }
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('awaitIndexBuilds() resolves and both BillingUsage unique indexes exist', async () => {
    const indexes = await collection.listIndexes().toArray();
    const monthIx = indexes.find((ix) => ix.key?.organizationId === 1 && ix.key?.month === 1);
    const weekIx = indexes.find((ix) => ix.key?.organizationId === 1 && ix.key?.weekKey === 1);

    expect(monthIx).toBeDefined();
    expect(monthIx.unique).toBe(true);
    expect(monthIx.partialFilterExpression).toEqual({ legacyPeriod: { $exists: true } });

    expect(weekIx).toBeDefined();
    expect(weekIx.unique).toBe(true);
    expect(weekIx.sparse).toBe(true);
  });

  test('meter replay is deterministic immediately after boot', async () => {
    const orgId = new mongoose.Types.ObjectId();
    trackedOrgIds.push(orgId);
    const weekKey = '2099-W05';
    const idempotencyKey = 'hist_boot_replay';
    const baseSnapshot = { month: '2099-05', meterQuota: 1000, planVersion: 'v1', resetAt: null };

    // First write — creates the document.
    const first = await BillingUsageRepository.incrementMeter(orgId.toString(), weekKey, 40, {}, idempotencyKey, baseSnapshot);
    expect(first).not.toBeNull();
    expect(first.meterUsed).toBe(40);

    // Replay — same idempotencyKey. Because the unique index was already built
    // before this write path could even start (boot awaited it in beforeAll),
    // this must ALWAYS no-op (return null) — never create a second document.
    // Before the fix, an app that raced its first writes against the index
    // build could land here with the index still missing and double-write.
    const replay = await BillingUsageRepository.incrementMeter(orgId.toString(), weekKey, 40, {}, idempotencyKey, baseSnapshot);
    expect(replay).toBeNull();

    const count = await collection.countDocuments({ organizationId: orgId, weekKey });
    expect(count).toBe(1);
    const doc = await collection.findOne({ organizationId: orgId, weekKey });
    expect(doc.meterUsed).toBe(40);
  });

  test('legacy month-keyed increment stays a single document under concurrent upserts', async () => {
    const orgId = new mongoose.Types.ObjectId();
    trackedOrgIds.push(orgId);
    const month = '2099-05';

    // Two concurrently-issued upserts simulate the exact race the unique index
    // guards against — without it (or without the index being built yet), both
    // could land as separate inserts.
    await Promise.all([
      BillingUsageRepository.increment(orgId.toString(), month, 'executions', 1),
      BillingUsageRepository.increment(orgId.toString(), month, 'executions', 1),
    ]);

    const count = await collection.countDocuments({ organizationId: orgId, month });
    expect(count).toBe(1);
    const doc = await collection.findOne({ organizationId: orgId, month });
    expect(doc.counters.executions).toBe(2);
    expect(doc.legacyPeriod).toBe(true);
  });
});
