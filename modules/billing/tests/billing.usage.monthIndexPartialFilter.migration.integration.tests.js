/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20260727120000-fix-usage-month-index-partial-filter.js';

const INDEX_NAME = 'organizationId_1_month_1';
const INDEX_KEY = { organizationId: 1, month: 1 };

/**
 * Migration `20260727120000-fix-usage-month-index-partial-filter` (#3990).
 *
 * The old schema spec used `$exists: false` in its partialFilterExpression —
 * unsupported by MongoDB — so the unique (organizationId, month) guard NEVER
 * materialized on any database (autoIndex failures land on the model's
 * unlistened 'index' event). Verifies the fixed end state via the RAW
 * collection driver:
 *   - up() backfills the `legacyPeriod` discriminator onto pre-existing legacy
 *     (non-meter) documents BEFORE creating the index;
 *   - meter-mode documents (weekKey present) never get the discriminator;
 *   - up() creates `organizationId_1_month_1` with the EXACT spec (key, unique,
 *     $exists:true filter);
 *   - idempotent (a second run leaves exactly one index on the key);
 *   - a same-key index living under another name is dropped and replaced;
 *   - pre-existing duplicate legacy (organizationId, month) pairs ABORT the
 *     migration before any write — index or document;
 *   - REWORKED ORDERING (#3990 review): boot now runs `awaitIndexBuilds()`
 *     BEFORE `migrations.run()` (see lib/app.js#bootstrap), so on a first
 *     boot after this schema ships, the partial index may already be LIVE
 *     AND EMPTY by the time `up()` runs. `ensureBootBuiltIndex()` below
 *     reproduces exactly that state directly (bypassing this migration), and
 *     the success + abort tests below use REAL-WORLD fixtures — legacy docs
 *     that lack `legacyPeriod` entirely (the actual pre-migration shape) —
 *     against that already-live index.
 */
describe('Migration usage-month-index-partial-filter:', () => {
  let usages;
  const orgId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await bootstrap();
    usages = mongoose.connection.db.collection('billingusages');
  });

  afterAll(async () => {
    try {
      await usages.deleteMany({ organizationId: orgId });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  /**
   * @desc Finds an index by name in the billingusages collection.
   * @param {string} name - the index name to look up.
   * @returns {Promise<Object|undefined>} the index descriptor if found, undefined otherwise.
   */
  const findIndex = async (name) => {
    const indexes = await usages.listIndexes().toArray();
    return indexes.find((ix) => ix.name === name);
  };

  /**
   * @desc Simulates the boot-built state (#3990 review): creates the
   * schema-declared partial index directly — bypassing this migration — the
   * same end state `awaitIndexBuilds()` leaves BEFORE `migrations.run()` now
   * runs (see lib/app.js#bootstrap). Used to prove `up()` stays safe when it
   * finds this index already live-and-empty going in.
   * @returns {Promise<void>}
   */
  const ensureBootBuiltIndex = async () => {
    try {
      await usages.dropIndex(INDEX_NAME);
    } catch (_) { /* already absent */ }
    await usages.createIndex(INDEX_KEY, {
      unique: true,
      name: INDEX_NAME,
      partialFilterExpression: { legacyPeriod: { $exists: true } },
    });
  };

  test('up() creates organizationId_1_month_1 with the exact spec', async () => {
    await up();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ organizationId: 1, month: 1 });
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ legacyPeriod: { $exists: true } });
  });

  test('succeeds when boot already built the index empty and legacy docs lack legacyPeriod (real-world boot-ordering state, #3990)', async () => {
    const docId = new mongoose.Types.ObjectId();
    try {
      // Reproduce boot's actual state: awaitIndexBuilds() already built the
      // schema-declared index (live, empty) BEFORE this migration runs.
      await ensureBootBuiltIndex();
      // Real-world pre-migration document shape: legacy (no weekKey) and no
      // legacyPeriod yet — backfilling it is exactly this migration's job.
      await usages.insertOne({ _id: docId, organizationId: orgId, month: '2020-05', counters: { executions: 1 } });

      await up();

      const ix = await findIndex(INDEX_NAME);
      expect(ix).toBeDefined();
      expect(ix.key).toEqual({ organizationId: 1, month: 1 });
      expect(ix.unique).toBe(true);
      expect(ix.partialFilterExpression).toEqual({ legacyPeriod: { $exists: true } });

      const doc = await usages.findOne({ _id: docId });
      expect(doc.legacyPeriod).toBe(true);
    } finally {
      await usages.deleteMany({ _id: docId });
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('is idempotent — a second run leaves exactly one index on the key', async () => {
    await up();
    await up();
    const indexes = await usages.listIndexes().toArray();
    const sameKey = indexes.filter((ix) => ix.key && ix.key.organizationId === 1 && ix.key.month === 1);
    expect(sameKey.length).toBe(1);
    expect(sameKey[0].name).toBe(INDEX_NAME);
  });

  test('drops a same-key index living under another name and installs the canonical one', async () => {
    try { await usages.dropIndex(INDEX_NAME); } catch (_) { /* already absent */ }
    await usages.createIndex({ organizationId: 1, month: 1 }, { name: 'legacy_org_month' });
    await up();
    expect(await findIndex('legacy_org_month')).toBeUndefined();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.unique).toBe(true);
  });

  test('backfills legacyPeriod onto a pre-existing legacy document (no weekKey) before indexing', async () => {
    const docId = new mongoose.Types.ObjectId();
    try {
      try { await usages.dropIndex(INDEX_NAME); } catch (_) { /* already absent */ }
      await usages.insertOne({
        _id: docId, organizationId: orgId, month: '2020-01', counters: { executions: 3 },
      });
      await up();
      const doc = await usages.findOne({ _id: docId });
      expect(doc.legacyPeriod).toBe(true);
    } finally {
      await usages.deleteMany({ _id: docId });
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('never backfills legacyPeriod onto a meter-mode document (weekKey present)', async () => {
    const docId = new mongoose.Types.ObjectId();
    try {
      await usages.insertOne({
        _id: docId, organizationId: orgId, month: '2020-01', weekKey: '2020-W01', meterUsed: 5, meterQuota: 100,
      });
      await up();
      const doc = await usages.findOne({ _id: docId });
      expect(doc.legacyPeriod).toBeUndefined();
    } finally {
      await usages.deleteMany({ _id: docId });
    }
  });

  test('ABORTS on pre-existing duplicate legacy (organizationId, month) pairs without touching indexes or documents', async () => {
    const dupA = new mongoose.Types.ObjectId();
    const dupB = new mongoose.Types.ObjectId();
    // The UNRELATED (organizationId, weekKey) sparse unique index is a
    // COMPOUND sparse index: MongoDB only excludes a document from a
    // compound sparse index when it is missing ALL indexed fields — since
    // organizationId is always present, two legacy (weekKey-absent) docs for
    // the SAME org collide on it too, independent of month. Such duplicate
    // legacy rows realistically predate that index's existence (added
    // 2026-05-01 by the meter-fields migration) — simulate that history by
    // dropping it for the span of this test only, then restoring its exact
    // spec. Out of scope for this migration (#3990 review only touches the
    // (organizationId, month) index) — this is test setup, not a fix.
    const weekKeyIndexes = (await usages.listIndexes().toArray()).filter((ix) => ix.key?.organizationId === 1 && ix.key?.weekKey === 1);
    try {
      for (const ix of weekKeyIndexes) {
        await usages.dropIndex(ix.name);
      }
      // Reproduce boot's actual state: the (organizationId, month) index is
      // already live (empty) BEFORE this migration runs — the abort must
      // still happen before any write, so the pre-check cannot depend on
      // that index being absent.
      await ensureBootBuiltIndex();
      // Real-world pre-migration shape: legacy (no weekKey), no legacyPeriod
      // yet. Both docs are excluded from the (already-live) partial index —
      // it only covers legacyPeriod:{$exists:true} — so inserting the
      // duplicate pair here cannot itself trip E11000; only up()'s pre-check
      // is under test.
      await usages.insertOne({ _id: dupA, organizationId: orgId, month: '2021-06', counters: {} });
      await usages.insertOne({ _id: dupB, organizationId: orgId, month: '2021-06', counters: {} });

      await expect(up()).rejects.toThrow(/duplicate legacy usage/);

      // Abort happened before ANY write: neither doc was backfilled (zero
      // docs modified) and the pre-existing (organizationId, month) index
      // was left untouched.
      const docA = await usages.findOne({ _id: dupA });
      const docB = await usages.findOne({ _id: dupB });
      expect(docA.legacyPeriod).toBeUndefined();
      expect(docB.legacyPeriod).toBeUndefined();
      const ix = await findIndex(INDEX_NAME);
      expect(ix).toBeDefined();
      expect(ix.partialFilterExpression).toEqual({ legacyPeriod: { $exists: true } });
    } finally {
      await usages.deleteMany({ _id: { $in: [dupA, dupB] } });
      for (const ix of weekKeyIndexes) {
        await usages.createIndex(ix.key, { name: ix.name, unique: ix.unique, sparse: ix.sparse });
      }
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('schema twin is IDENTICAL — syncIndexes() has nothing to drop or rebuild', async () => {
    await up();
    const BillingUsage = mongoose.model('BillingUsage');
    const dropped = await BillingUsage.syncIndexes();
    expect(dropped).toEqual([]);
    expect(await findIndex(INDEX_NAME)).toBeDefined();
  });

  test('DB backstop: a second legacy row for the same (org, month) rejects with E11000', async () => {
    await up();
    const BillingUsage = mongoose.model('BillingUsage');
    // Bypass the repository's upsert-then-catch guard on purpose: the index
    // itself must reject the duplicate.
    await BillingUsage.create({ organizationId: orgId, month: '2022-09', legacyPeriod: true, counters: {} });
    await expect(
      BillingUsage.create({ organizationId: orgId, month: '2022-09', legacyPeriod: true, counters: {} }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await BillingUsage.countDocuments({ organizationId: orgId, month: '2022-09' })).toBe(1);
  });

  test('meter-mode rows stay OUTSIDE the partial index (may repeat per org/month, one per weekKey)', async () => {
    const BillingUsage = mongoose.model('BillingUsage');
    await BillingUsage.create({ organizationId: orgId, month: '2023-03', weekKey: '2023-W09', meterUsed: 0, meterQuota: 0 });
    await BillingUsage.create({ organizationId: orgId, month: '2023-03', weekKey: '2023-W10', meterUsed: 0, meterQuota: 0 });
    expect(await BillingUsage.countDocuments({ organizationId: orgId, month: '2023-03' })).toBe(2);
  });
});
