/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { jest, beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20260729120000-fix-processed-stripe-event-ttl-index-partial-filter.js';

const INDEX_NAME = 'processedAt_1';
const INDEX_KEY = { processedAt: 1 };
const TTL_SECONDS = 30 * 24 * 60 * 60;
const EVENT_PREFIX = 'evt_ttl_partial_migration_test_';

/**
 * Migration `20260729120000-fix-processed-stripe-event-ttl-index-partial-filter` (#4006).
 *
 * The schema's 30-day TTL index on `processedAt` gained
 * `partialFilterExpression: { deadLetter: { $eq: false } }` with no
 * accompanying migration. An already-deployed database still holding the
 * plain `processedAt_1` TTL index hits IndexOptionsConflict (code 85) at
 * every boot — tolerated since #4004, but the live index keeps purging
 * dead-letter documents until THIS migration swaps it. Documents written
 * before the `deadLetter` field existed also fall outside the partial filter
 * (query-match semantics: `$eq: false` never matches a missing field) and
 * would never expire — the migration backfills `deadLetter: false` onto them.
 *
 * `ensureLegacyState()` below reproduces the real already-deployed
 * pre-migration state directly (bypassing this migration): the OLD plain TTL
 * index live under the canonical name — the exact same-name/different-options
 * shape that conflicts with the schema declaration at boot. Verifies the
 * fixed end state via the RAW collection driver.
 */
describe('Migration processed-stripe-event-ttl-index-partial-filter:', () => {
  let events;

  beforeAll(async () => {
    await bootstrap();
    events = mongoose.connection.db.collection('processedstripeevents');
  });

  afterAll(async () => {
    try {
      await events.deleteMany({ eventId: { $regex: `^${EVENT_PREFIX}` } });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  /**
   * @desc Finds an index by name in the processedstripeevents collection.
   * @param {string} name - the index name to look up.
   * @returns {Promise<Object|undefined>} the index descriptor if found, undefined otherwise.
   */
  const findIndex = async (name) => {
    const indexes = await events.listIndexes().toArray();
    return indexes.find((ix) => ix.name === name);
  };

  /**
   * @desc Simulates the real already-deployed, pre-migration state: the OLD
   * plain TTL index (no partial filter) live under the canonical default name
   * `processedAt_1` — the exact same-name/different-options shape the schema
   * declaration conflicts with at boot (#4004). Used to prove `up()` swaps it
   * to the target spec instead of leaving the wrong semantics live forever.
   * @returns {Promise<void>}
   */
  const ensureLegacyState = async () => {
    const sameKeyIndexes = (await events.listIndexes().toArray()).filter((ix) => ix.key?.processedAt === 1);
    for (const ix of sameKeyIndexes) {
      await events.dropIndex(ix.name);
    }
    await events.createIndex(INDEX_KEY, { name: INDEX_NAME, expireAfterSeconds: TTL_SECONDS });
  };

  test('up() installs the dead-letter-preserving TTL index with the exact schema spec', async () => {
    await up();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ processedAt: 1 });
    expect(ix.expireAfterSeconds).toBe(TTL_SECONDS);
    expect(ix.partialFilterExpression).toEqual({ deadLetter: { $eq: false } });
    expect(ix.unique).toBeUndefined();
  });

  test('legacy plain TTL under the canonical name is swapped to the target spec; field-less docs get backfilled, dead-letter docs stay untouched (#4006)', async () => {
    const preFieldId = new mongoose.Types.ObjectId();
    const liveId = new mongoose.Types.ObjectId();
    const deadId = new mongoose.Types.ObjectId();
    try {
      await ensureLegacyState();
      // Raw driver inserts — bypass mongoose defaults so a document genuinely
      // MISSING `deadLetter` (pre-field era) can exist.
      await events.insertOne({ _id: preFieldId, eventId: `${EVENT_PREFIX}pre_field`, type: 'checkout.session.completed', processedAt: new Date() });
      await events.insertOne({ _id: liveId, eventId: `${EVENT_PREFIX}live`, type: 'invoice.paid', processedAt: new Date(), deadLetter: false });
      await events.insertOne({ _id: deadId, eventId: `${EVENT_PREFIX}dead`, type: 'invoice.paid', processedAt: new Date(), attempts: 5, deadLetter: true });

      await up();

      const ix = await findIndex(INDEX_NAME);
      expect(ix).toBeDefined();
      expect(ix.expireAfterSeconds).toBe(TTL_SECONDS);
      expect(ix.partialFilterExpression).toEqual({ deadLetter: { $eq: false } });

      // Pre-field document re-enters the TTL's scope via the backfill…
      expect((await events.findOne({ _id: preFieldId })).deadLetter).toBe(false);
      // …while already-written values are untouched.
      expect((await events.findOne({ _id: liveId })).deadLetter).toBe(false);
      expect((await events.findOne({ _id: deadId })).deadLetter).toBe(true);
      expect((await events.findOne({ _id: deadId })).attempts).toBe(5);
    } finally {
      await events.deleteMany({ _id: { $in: [preFieldId, liveId, deadId] } });
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('is idempotent — a second run leaves exactly one index on the key', async () => {
    await up();
    await up();
    const indexes = await events.listIndexes().toArray();
    const sameKeyIndexes = indexes.filter((ix) => ix.key?.processedAt === 1 && Object.keys(ix.key).length === 1);
    expect(sameKeyIndexes.length).toBe(1);
    expect(sameKeyIndexes[0].name).toBe(INDEX_NAME);
  });

  test('drops a same-key index living under another name and installs the canonical one', async () => {
    const sameKeyIndexes = (await events.listIndexes().toArray()).filter((ix) => ix.key?.processedAt === 1);
    for (const ix of sameKeyIndexes) {
      await events.dropIndex(ix.name);
    }
    await events.createIndex(INDEX_KEY, { name: 'divergent_processedAt_index' });

    await up();

    expect(await findIndex('divergent_processedAt_index')).toBeUndefined();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.partialFilterExpression).toEqual({ deadLetter: { $eq: false } });
  });

  test('ABORTS loud on a field-less document carrying dead-letter-era evidence — never guesses, backfills nothing', async () => {
    // Impossible via any code path (deadLetter shipped with attempts/lastError
    // and the schema default materializes it on every write since) — but
    // manual surgery / partial restores can produce it, and flipping such a
    // document to false could mark a genuine permanent rejection purgeable.
    const ambiguousId = new mongoose.Types.ObjectId();
    const plainId = new mongoose.Types.ObjectId();
    try {
      await ensureLegacyState();
      await events.insertOne({ _id: ambiguousId, eventId: `${EVENT_PREFIX}ambiguous`, type: 'invoice.paid', processedAt: new Date(), attempts: 5, lastError: 'handler exploded', lastErrorAt: new Date() });
      await events.insertOne({ _id: plainId, eventId: `${EVENT_PREFIX}plain`, type: 'invoice.paid', processedAt: new Date() });

      await expect(up()).rejects.toThrow(/carrying dead-letter-era evidence/);

      // Abort happened before ANY write: neither document was backfilled and
      // the legacy index is still live (the swap never ran).
      expect((await events.findOne({ _id: ambiguousId })).deadLetter).toBeUndefined();
      expect((await events.findOne({ _id: plainId })).deadLetter).toBeUndefined();
      const ix = await findIndex(INDEX_NAME);
      expect(ix.partialFilterExpression).toBeUndefined();
    } finally {
      await events.deleteMany({ _id: { $in: [ambiguousId, plainId] } });
      await up(); // restore the migrated end state for the suites that follow
    }
  });

  test('skip-window fast path — a converged database does not touch indexes', async () => {
    // Converge first (idempotent — also backfills any stray field-less doc,
    // so the fast path's backfill probe finds nothing).
    await up();

    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await up();
      const messages = infoSpy.mock.calls.map((args) => args[0]);
      expect(messages.some((m) => m.includes('skipping entirely'))).toBe(true);
      expect(messages.some((m) => m.includes('dropped index'))).toBe(false);
      expect(messages.some((m) => m.includes('created dead-letter-preserving'))).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }

    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.partialFilterExpression).toEqual({ deadLetter: { $eq: false } });
  });

  test('schema twin is IDENTICAL — syncIndexes() has nothing to drop or rebuild', async () => {
    await up();
    const ProcessedStripeEvent = mongoose.model('ProcessedStripeEvent');
    const dropped = await ProcessedStripeEvent.syncIndexes();
    expect(dropped).toEqual([]);
    expect(await findIndex(INDEX_NAME)).toBeDefined();
  });
});
