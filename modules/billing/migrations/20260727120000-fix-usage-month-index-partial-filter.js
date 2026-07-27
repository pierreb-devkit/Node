/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const INDEX_NAME = 'organizationId_1_month_1';
const INDEX_KEY = { organizationId: 1, month: 1 };

/**
 * @desc Exact-key match helper: a two-field index keyed (organizationId:1, month:1)
 * in that order.
 * @param {Object} ix - an index document from listIndexes()
 * @return {boolean} true when the index key is exactly { organizationId:1, month:1 }
 */
const sameKey = (ix) => {
  const keys = Object.keys(ix.key || {});
  return keys.length === 2 && keys[0] === 'organizationId' && keys[1] === 'month'
    && ix.key.organizationId === 1 && ix.key.month === 1;
};

/**
 * Migration: working (organizationId, month) legacy-usage partial-unique index (#3990).
 *
 * The schema previously declared partialFilterExpression
 * `{ weekKey: { $exists: false } }` — MongoDB does NOT support `$exists: false`
 * (or `$ne`) inside a partialFilterExpression (only `$eq`, `$exists: true`, `$gt`,
 * `$gte`, `$lt`, `$lte`, `$type`, and the top-level `$and` are allowed). Mongoose
 * autoIndex reports that failure on the model's 'index' event, where nothing
 * listens, so the index NEVER existed on any deployed database and the
 * (organizationId, month) uniqueness guard for legacy (non-meter) usage
 * documents ran on application code alone (racy findOneAndUpdate-with-upsert in
 * BillingUsageRepository.increment).
 *
 * New spec (the schema declares the IDENTICAL twin): unique on
 * { organizationId: 1, month: 1 }, partialFilterExpression
 * { legacyPeriod: { $exists: true } }. `legacyPeriod` is a new boolean
 * discriminator set only by the legacy write path (BillingUsageRepository
 * .increment's $setOnInsert) — meter-mode documents (incrementMeter /
 * upsertWeekSnapshot, keyed by weekKey) never set it. This flips the
 * unsupported "weekKey absent" condition into a supported positive
 * $exists:true check while preserving the original intent: only legacy,
 * non-meter usage documents are covered by this uniqueness constraint.
 *
 * Ordering (REWORKED — #3990 review): boot now runs
 * `startMongoose()` (autoIndex + `awaitIndexBuilds()`) BEFORE
 * `migrations.run()` (see lib/app.js#bootstrap). That means on a first boot
 * after this schema change deploys, the partial index above may ALREADY be
 * LIVE (built empty by autoIndex) by the time this migration's `up()` runs —
 * this migration must be safe against that, not just against a fresh/absent
 * index:
 *   (a) Duplicate pre-check FIRST, ZERO writes. Query (not index-filter) the
 *       legacy shape directly — `weekKey: { $exists: false }` is a supported
 *       QUERY filter (only partial-INDEX filters forbid `$exists: false`) —
 *       group by (organizationId, month), abort loud on any count > 1. This
 *       must run before any write below, because if the index is already
 *       live-and-empty (boot-built), the backfill write in (c) would
 *       otherwise hit a raw E11000 mid-`updateMany` on the first duplicate
 *       pair, leaving the collection partially backfilled.
 *   (b) Drop the partial index if present — it may be live-and-empty from
 *       boot, a divergent same-key index under another name, or absent on an
 *       old/never-migrated database. Dropping first guarantees no unique
 *       constraint is live while (c) writes.
 *   (c) Backfill `legacyPeriod: true` onto existing legacy documents. Safe
 *       now — no index is live to race against, and (a) already proved no
 *       duplicate pair exists.
 *   (d) Recreate the index (same spec as the schema declaration).
 * Idempotent on re-run: a second `up()` finds no duplicates (backfill is a
 * no-op the second time), drops the index it just created, and recreates it
 * — same end state, just an extra drop/create round-trip.
 *
 * autoIndex race: mongoose autoIndex:true (the default — db.options sets no
 * override) builds the schema-declared twin on connect; identical specs make
 * the race benign. This migration is the AUTHORITATIVE creator on
 * already-deployed databases (it owns the backfill autoIndex cannot do).
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const usages = mongoose.connection.db.collection('billingusages');

  // ── (a) Duplicate pre-check FIRST — zero writes so far. Safe whether the
  // partial index is already live (boot-built empty) or absent: this reads
  // via a plain query filter, never a partial-index filter, so `$exists:
  // false` is fine here. `.aggregate()` on a missing/empty collection just
  // returns an empty result (unlike `.listIndexes()` below), so this is also
  // safe on a fresh database.
  const duplicates = await usages
    .aggregate([
      { $match: { weekKey: { $exists: false } } },
      { $group: { _id: { organizationId: '$organizationId', month: '$month' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length > 0) {
    // Emit only usage document ids — never organization identities — in
    // operator-facing errors.
    const sample = duplicates
      .slice(0, 10)
      .map((d) => `(${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
      .join('; ');
    throw new Error(
      `[migration] usage-month-index-partial-filter ABORTED: ${duplicates.length} duplicate legacy usage (organizationId, month) group(s) would violate the unique index. ` +
        `Remediate (delete/merge the duplicate rows) before re-running — this migration will NOT pick winners. Sample (ids only): ${sample}`,
    );
  }

  // Snapshot existing indexes once (listIndexes throws if the collection does not
  // exist yet — tolerate that: a fresh DB has no billingusages collection and
  // autoIndex / syncIndexes will create the index from the schema declaration).
  let existing = [];
  try {
    existing = await usages.listIndexes().toArray();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      console.info('[migration] usage-month-index-partial-filter: billingusages collection does not exist yet — nothing to migrate');
      return;
    }
    throw err;
  }

  // ── (b) Drop the partial index if present, BEFORE the backfill write below.
  // It may already be LIVE AND EMPTY — boot's awaitIndexBuilds() builds the
  // schema-declared twin before this migration runs — or a divergent
  // same-key index living under another name. Either way it must not be live
  // while (c) writes `legacyPeriod`, since (a) already proved there is no
  // duplicate to violate it, but a stale/empty index would still intercept
  // every write in the updateMany one document at a time.
  for (const ix of existing) {
    if (ix.name === '_id_') continue;
    if (sameKey(ix) || ix.name === INDEX_NAME) {
      await usages.dropIndex(ix.name);
      console.info(`[migration] usage-month-index-partial-filter: dropped index '${ix.name}' before backfill (boot-built empty or divergent)`);
    }
  }

  // ── (c) Backfill the discriminator onto existing legacy documents ──
  // No-op (matches nothing) on a fresh database where the collection is empty,
  // and safe here — no unique constraint is live to race against, and (a)
  // already confirmed no duplicate (organizationId, month) pair exists.
  const backfillResult = await usages.updateMany(
    { weekKey: { $exists: false }, legacyPeriod: { $exists: false } },
    { $set: { legacyPeriod: true } },
  );
  if (backfillResult.modifiedCount > 0) {
    console.info(`[migration] usage-month-index-partial-filter: backfilled legacyPeriod on ${backfillResult.modifiedCount} document(s)`);
  }

  // ── (d) Recreate the partial-unique index (same spec as the schema declaration) ──
  await usages.createIndex(INDEX_KEY, {
    unique: true,
    name: INDEX_NAME,
    partialFilterExpression: { legacyPeriod: { $exists: true } },
  });
  console.info('[migration] usage-month-index-partial-filter: created partial-unique index on (organizationId, month)');
}

/**
 * Down: no-op (warn). The pre-fix state was a unique guard that silently never
 * existed — restoring "no index" would reintroduce the bug. Rollback = revert
 * the schema declaration deliberately, then drop the index by hand if truly
 * needed. The `legacyPeriod` backfill is left in place (harmless additive
 * field with no other reader).
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] usage-month-index-partial-filter DOWN: no-op; drop the (organizationId, month) index manually only alongside a deliberate schema revert',
  );
}
