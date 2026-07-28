/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { jest, beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20260728120000-fix-usage-weekkey-index-partial.js';

const OLD_INDEX_NAME = 'organizationId_1_weekKey_1';
const NEW_INDEX_NAME = 'organizationId_1_weekKey_1_partial';
const INDEX_KEY = { organizationId: 1, weekKey: 1 };

/**
 * Migration `20260728120000-fix-usage-weekkey-index-partial` (#3991).
 *
 * The old schema spec used `sparse: true` on a COMPOUND index — valid syntax,
 * but MongoDB's sparse-exclusion rule only skips a document when it is missing
 * ALL indexed fields. `organizationId` is always present, so every legacy
 * (weekKey-less) document was indexed too (weekKey treated as `null`), and a
 * second legacy month for the same org collided as a duplicate key, silently
 * losing the write (see the model comment + `BillingUsageRepository.increment`).
 *
 * Unlike #3990 (an invalid partial filter that never built ANYWHERE), this old
 * index IS live on every already-deployed database. The fix therefore cannot
 * reuse the old default name (`organizationId_1_weekKey_1`) for the new spec —
 * doing so would make autoIndex (which now runs BEFORE migrations and SURFACES
 * build failures loudly, #3990) reject with IndexOptionsConflict on every boot
 * until an operator manually intervened. The new index gets an explicit
 * DIFFERENT name (`organizationId_1_weekKey_1_partial`) so it can be built
 * ALONGSIDE the still-live old one without conflict; this migration is the
 * authoritative creator of the new index AND dropper of the old one.
 *
 * `ensureBootBuiltIndex()` below reproduces the REAL post-deploy pre-migration
 * state directly (bypassing this migration): the new schema-declared index
 * already live (autoIndex built it under its distinct name with no conflict)
 * while the old sparse index — which the new schema no longer declares, so
 * autoIndex never touches it — is STILL live too. Verifies the fixed end state
 * via the RAW collection driver.
 */
describe('Migration usage-weekkey-index-partial:', () => {
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
   * @desc Simulates the real post-deploy, pre-migration state: the
   * schema-declared new partial index already live (autoIndex built it under
   * its own distinct name, no conflict with the old one) WHILE the old sparse
   * index — no longer schema-declared, so autoIndex never drops it — is still
   * live too. Used to prove `up()` stays safe and correctly drops the old
   * index when it finds this coexisting state going in.
   * @returns {Promise<void>}
   */
  const ensureBootBuiltIndex = async () => {
    try {
      await usages.dropIndex(NEW_INDEX_NAME);
    } catch (_) { /* already absent */ }
    try {
      await usages.dropIndex(OLD_INDEX_NAME);
    } catch (_) { /* already absent */ }
    await usages.createIndex(INDEX_KEY, {
      unique: true,
      name: NEW_INDEX_NAME,
      partialFilterExpression: { weekKey: { $exists: true } },
    });
    await usages.createIndex(INDEX_KEY, { unique: true, sparse: true, name: OLD_INDEX_NAME });
  };

  test('up() creates organizationId_1_weekKey_1_partial with the exact spec', async () => {
    await up();
    const ix = await findIndex(NEW_INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ organizationId: 1, weekKey: 1 });
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ weekKey: { $exists: true } });
  });

  test('succeeds when boot already built the new index AND the legacy sparse index is still live (real-world already-deployed state, #3991)', async () => {
    const legacyDocId = new mongoose.Types.ObjectId();
    const meterDocId = new mongoose.Types.ObjectId();
    try {
      await ensureBootBuiltIndex();
      await usages.insertOne({ _id: legacyDocId, organizationId: orgId, month: '2020-05', legacyPeriod: true, counters: { executions: 1 } });
      await usages.insertOne({ _id: meterDocId, organizationId: orgId, month: '2020-05', weekKey: '2020-W20', meterUsed: 3, meterQuota: 100 });

      await up();

      const ix = await findIndex(NEW_INDEX_NAME);
      expect(ix).toBeDefined();
      expect(ix.key).toEqual({ organizationId: 1, weekKey: 1 });
      expect(ix.unique).toBe(true);
      expect(ix.partialFilterExpression).toEqual({ weekKey: { $exists: true } });
      expect(await findIndex(OLD_INDEX_NAME)).toBeUndefined();

      // Documents are untouched — this migration is index-only, no backfill.
      const legacyDoc = await usages.findOne({ _id: legacyDocId });
      const meterDoc = await usages.findOne({ _id: meterDocId });
      expect(legacyDoc.counters.executions).toBe(1);
      expect(meterDoc.meterUsed).toBe(3);
    } finally {
      await usages.deleteMany({ _id: { $in: [legacyDocId, meterDocId] } });
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('is idempotent — a second run leaves exactly one index on the key', async () => {
    await up();
    await up();
    const indexes = await usages.listIndexes().toArray();
    const sameKeyIndexes = indexes.filter((ix) => ix.key && ix.key.organizationId === 1 && ix.key.weekKey === 1);
    expect(sameKeyIndexes.length).toBe(1);
    expect(sameKeyIndexes[0].name).toBe(NEW_INDEX_NAME);
  });

  test('drops a same-key index living under another name and installs the canonical one', async () => {
    try { await usages.dropIndex(NEW_INDEX_NAME); } catch (_) { /* already absent */ }
    try { await usages.dropIndex(OLD_INDEX_NAME); } catch (_) { /* already absent */ }
    await usages.createIndex(INDEX_KEY, { name: 'divergent_weekkey_index' });
    await up();
    expect(await findIndex('divergent_weekkey_index')).toBeUndefined();
    const ix = await findIndex(NEW_INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.unique).toBe(true);
  });

  test('an index already under NEW_INDEX_NAME with divergent options is dropped and recreated to the target spec (not a permanent IndexOptionsConflict)', async () => {
    try { await usages.dropIndex(NEW_INDEX_NAME); } catch (_) { /* already absent */ }
    try { await usages.dropIndex(OLD_INDEX_NAME); } catch (_) { /* already absent */ }
    // A same-name index with a divergent spec (e.g. a hand-fix or an earlier
    // iteration of this migration) must not be a permanent IndexOptionsConflict
    // — up() must drop and recreate it under the target spec, not crash-loop.
    await usages.createIndex(INDEX_KEY, { name: NEW_INDEX_NAME, unique: false });

    await up();

    const ix = await findIndex(NEW_INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ organizationId: 1, weekKey: 1 });
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ weekKey: { $exists: true } });
  });

  test('ABORTS on pre-existing duplicate meter-mode (organizationId, weekKey) pairs without touching indexes', async () => {
    const dupA = new mongoose.Types.ObjectId();
    const dupB = new mongoose.Types.ObjectId();
    // Drop every index on this key so both duplicate inserts can land — the
    // abort must happen before any index write, so the pre-check cannot
    // depend on any constraint already being absent OR present.
    const weekKeyIndexes = (await usages.listIndexes().toArray()).filter((ix) => ix.key?.organizationId === 1 && ix.key?.weekKey === 1);
    try {
      for (const ix of weekKeyIndexes) {
        await usages.dropIndex(ix.name);
      }
      await usages.insertOne({ _id: dupA, organizationId: orgId, month: '2021-06', weekKey: '2021-W24', meterUsed: 1, meterQuota: 100 });
      await usages.insertOne({ _id: dupB, organizationId: orgId, month: '2021-06', weekKey: '2021-W24', meterUsed: 2, meterQuota: 100 });

      await expect(up()).rejects.toThrow(/duplicate meter-mode usage/);

      // Abort happened before ANY index write — neither the old nor the new
      // index exists (both were dropped above, and up() never got past the
      // pre-check).
      expect(await findIndex(NEW_INDEX_NAME)).toBeUndefined();
      expect(await findIndex(OLD_INDEX_NAME)).toBeUndefined();
    } finally {
      await usages.deleteMany({ _id: { $in: [dupA, dupB] } });
      // Replay the FULL captured descriptor(s) rather than a hand-picked
      // subset, then converge via up() for the suites that follow.
      for (const ix of weekKeyIndexes) {
        const { key, name, ...options } = ix;
        delete options.v; // server-assigned index format version — not a createIndex option
        await usages.createIndex(key, { name, ...options });
      }
      await up();
    }
  });

  test('createIndex E11000 during index creation aborts loud, same shape as the pre-check', async () => {
    // Simulates a concurrent write landing a duplicate pair between the
    // pre-check and the create call — force the full create path to run
    // (drop every index on the key), then make createIndex reject with a raw
    // E11000 the way the MongoDB server would on a genuine race, proving the
    // migration converts that into the same documented, actionable abort as
    // the upfront pre-check rather than letting a bare driver error escape.
    const weekKeyIndexes = (await usages.listIndexes().toArray()).filter((ix) => ix.key?.organizationId === 1 && ix.key?.weekKey === 1);
    try {
      for (const ix of weekKeyIndexes) {
        await usages.dropIndex(ix.name);
      }

      const realCollection = mongoose.connection.db.collection('billingusages');
      const createIndexSpy = jest.spyOn(realCollection, 'createIndex').mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error collection: billingusages index: organizationId_1_weekKey_1_partial'), { code: 11000 }),
      );
      const collectionSpy = jest.spyOn(mongoose.connection.db, 'collection').mockReturnValue(realCollection);

      try {
        await expect(up()).rejects.toThrow(/duplicate \(organizationId, weekKey\) pair landed during migration/);
      } finally {
        collectionSpy.mockRestore();
        createIndexSpy.mockRestore();
      }
    } finally {
      for (const ix of weekKeyIndexes) {
        const { key, name, ...options } = ix;
        delete options.v;
        try { await usages.dropIndex(name); } catch (_) { /* already absent */ }
        await usages.createIndex(key, { name, ...options });
      }
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('skip-window fast path — a converged database does not touch indexes', async () => {
    // Converge first (idempotent, matches whatever end state prior tests left).
    await up();

    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await up();
      const messages = infoSpy.mock.calls.map((args) => args[0]);
      expect(messages.some((m) => m.includes('skipping entirely'))).toBe(true);
      expect(messages.some((m) => m.includes('dropped legacy index'))).toBe(false);
      expect(messages.some((m) => m.includes('created partial-unique index'))).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }

    const ix = await findIndex(NEW_INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ weekKey: { $exists: true } });
  });

  test('schema twin is IDENTICAL — syncIndexes() has nothing to drop or rebuild', async () => {
    await up();
    const BillingUsage = mongoose.model('BillingUsage');
    const dropped = await BillingUsage.syncIndexes();
    expect(dropped).toEqual([]);
    expect(await findIndex(NEW_INDEX_NAME)).toBeDefined();
  });

  test('DB backstop: a second meter-mode row for the same (org, weekKey) rejects with E11000', async () => {
    await up();
    const BillingUsage = mongoose.model('BillingUsage');
    await BillingUsage.create({ organizationId: orgId, month: '2022-09', weekKey: '2022-W36', meterUsed: 1, meterQuota: 100 });
    await expect(
      BillingUsage.create({ organizationId: orgId, month: '2022-09', weekKey: '2022-W36', meterUsed: 2, meterQuota: 100 }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await BillingUsage.countDocuments({ organizationId: orgId, weekKey: '2022-W36' })).toBe(1);
  });

  test('DB backstop: legacy (weekKey-less) rows for the same org across DIFFERENT months stay OUTSIDE the partial index and both persist (#3991)', async () => {
    await up();
    const BillingUsage = mongoose.model('BillingUsage');
    await BillingUsage.create({ organizationId: orgId, month: '2023-03', legacyPeriod: true, counters: { executions: 1 } });
    await BillingUsage.create({ organizationId: orgId, month: '2023-04', legacyPeriod: true, counters: { executions: 1 } });
    expect(await BillingUsage.countDocuments({ organizationId: orgId, month: { $in: ['2023-03', '2023-04'] } })).toBe(2);
  });
});
