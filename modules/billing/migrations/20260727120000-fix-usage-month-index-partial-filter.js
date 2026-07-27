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
 * Safety / ordering:
 *   (a) Backfill `legacyPeriod: true` onto existing documents that have no
 *       weekKey and no legacyPeriod yet — exactly the pre-existing legacy
 *       documents this index is meant to cover. No-ops on a fresh database
 *       (empty/missing collection).
 *   (b) Pre-check for existing duplicate (organizationId, month) pairs among
 *       legacy documents that would violate the unique index. If any exist we
 *       ABORT (throw) WITHOUT touching indexes — picking which duplicate row
 *       wins is an operator decision, not a migration's call.
 *   (c) Drop any divergent index first: a same-key index under another name
 *       (phantom/legacy spec) or a namesake whose options drifted.
 *   (d) Create the index. Idempotent: re-running after success is a no-op.
 *
 * autoIndex race: mongoose autoIndex:true (the default — db.options sets no
 * override) builds the schema-declared twin on connect; identical specs make
 * the race benign and syncIndexes() idempotent. This migration is the
 * AUTHORITATIVE creator for already-deployed databases.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const usages = mongoose.connection.db.collection('billingusages');

  // ── (a) Backfill the discriminator onto existing legacy documents ──
  // No-op (matches nothing) on a fresh database where the collection is empty
  // or does not exist yet.
  const backfillResult = await usages.updateMany(
    { weekKey: { $exists: false }, legacyPeriod: { $exists: false } },
    { $set: { legacyPeriod: true } },
  );
  if (backfillResult.modifiedCount > 0) {
    console.info(`[migration] usage-month-index-partial-filter: backfilled legacyPeriod on ${backfillResult.modifiedCount} document(s)`);
  }

  // ── (b) Pre-check: refuse to run if duplicate (organizationId, month) pairs exist ──
  const duplicates = await usages
    .aggregate([
      { $match: { legacyPeriod: true } },
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

  // ── (c) Drop divergent indexes / detect the exact expected shape ──
  let hasIndex = false;
  for (const ix of existing) {
    if (ix.name === '_id_') continue;
    const keyMatches = sameKey(ix);
    const exactShape = keyMatches
      && ix.name === INDEX_NAME
      && ix.unique === true
      && ix.partialFilterExpression?.legacyPeriod?.$exists === true;
    if (exactShape) {
      hasIndex = true;
    } else if (keyMatches || ix.name === INDEX_NAME) {
      await usages.dropIndex(ix.name);
      console.info(`[migration] usage-month-index-partial-filter: dropped divergent index '${ix.name}'`);
    }
  }

  // ── (d) Create the partial-unique index (idempotent) ──
  if (!hasIndex) {
    await usages.createIndex(INDEX_KEY, {
      unique: true,
      name: INDEX_NAME,
      partialFilterExpression: { legacyPeriod: { $exists: true } },
    });
    console.info('[migration] usage-month-index-partial-filter: created partial-unique index on (organizationId, month)');
  } else {
    console.info('[migration] usage-month-index-partial-filter: partial-unique index already present — skipping create');
  }
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
