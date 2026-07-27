/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20260727120000-fix-usage-month-index-partial-filter.js';

const INDEX_NAME = 'organizationId_1_month_1';

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
 *     migration before any index work.
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

  test('up() creates organizationId_1_month_1 with the exact spec', async () => {
    await up();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ organizationId: 1, month: 1 });
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ legacyPeriod: { $exists: true } });
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

  test('ABORTS on pre-existing duplicate legacy (organizationId, month) pairs without touching indexes', async () => {
    const dupA = new mongoose.Types.ObjectId();
    const dupB = new mongoose.Types.ObjectId();
    try {
      try { await usages.dropIndex(INDEX_NAME); } catch (_) { /* already absent */ }
      // Distinct dummy weekKey values so the two rows don't collide on the
      // UNRELATED (organizationId, weekKey) unique index — this test is only
      // about the (organizationId, month) duplicate pre-check.
      await usages.insertOne({ _id: dupA, organizationId: orgId, month: '2021-06', weekKey: 'dupA-probe', legacyPeriod: true, counters: {} });
      await usages.insertOne({ _id: dupB, organizationId: orgId, month: '2021-06', weekKey: 'dupB-probe', legacyPeriod: true, counters: {} });
      await expect(up()).rejects.toThrow(/duplicate legacy usage/);
      // Abort happened before any index work — the index is still absent.
      expect(await findIndex(INDEX_NAME)).toBeUndefined();
    } finally {
      await usages.deleteMany({ _id: { $in: [dupA, dupB] } });
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
