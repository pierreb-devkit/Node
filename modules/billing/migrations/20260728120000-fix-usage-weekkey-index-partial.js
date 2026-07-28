/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const OLD_INDEX_NAME = 'organizationId_1_weekKey_1';
const NEW_INDEX_NAME = 'organizationId_1_weekKey_1_partial';
const INDEX_KEY = { organizationId: 1, weekKey: 1 };

/**
 * @desc Exact-key match helper: a two-field index keyed (organizationId:1, weekKey:1)
 * in that order.
 * @param {Object} ix - an index document from listIndexes()
 * @returns {boolean} true when the index key is exactly { organizationId:1, weekKey:1 }
 */
const sameKey = (ix) => {
  const keys = Object.keys(ix.key || {});
  return keys.length === 2 && keys[0] === 'organizationId' && keys[1] === 'weekKey'
    && ix.key.organizationId === 1 && ix.key.weekKey === 1;
};

/**
 * @desc Exact-spec match helper: `sameKey` PLUS the correct name, uniqueness,
 * and partialFilterExpression — the full target shape this migration installs.
 * @param {Object} ix - an index document from listIndexes()
 * @returns {boolean} true when ix is already the fully-installed target index
 */
const isExactTargetIndex = (ix) =>
  sameKey(ix) && ix.name === NEW_INDEX_NAME && ix.unique === true && ix.partialFilterExpression?.weekKey?.$exists === true;

/**
 * @desc Group meter-mode documents (weekKey present) by (organizationId,
 * weekKey) and return only groups with more than one document — the shape the
 * unique partial index would reject. Shared by the upfront pre-check (a) and
 * the post-createIndex E11000 re-derivation, so both report the identical set.
 * @param {import('mongodb').Collection} usages - the billingusages collection.
 * @returns {Promise<Array<{_id: {organizationId: *, weekKey: string}, count: number, ids: Array}>>}
 */
const findWeekKeyDuplicates = (usages) =>
  usages
    .aggregate([
      { $match: { weekKey: { $exists: true } } },
      { $group: { _id: { organizationId: '$organizationId', weekKey: '$weekKey' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

/**
 * Migration: working (organizationId, weekKey) meter-mode partial-unique index (#3991).
 *
 * The schema previously declared `sparse: true` on this COMPOUND index. MongoDB's
 * sparse-exclusion rule for a compound index only skips a document when it is
 * missing ALL indexed fields — since `organizationId` is always present (on
 * legacy AND meter-mode documents alike), sparse never excluded anything: every
 * legacy (weekKey-less) document was indexed too, with weekKey treated as
 * `null`. A second legacy document for the SAME org (any month) collided on
 * `{organizationId, weekKey: null}` and was rejected as a duplicate key;
 * `BillingUsageRepository.increment`'s duplicate-key retry filter
 * (`{organizationId, month}`) then matched nothing for the new month, so the
 * write silently resolved to `null` with no document ever created — legacy
 * usage tracking stopped after an organization's first active month. Unlike
 * #3990 (an invalid `$exists: false` partial filter that never built ANYWHERE),
 * this `sparse: true` spec IS valid MongoDB syntax — it built successfully and
 * is LIVE on every already-deployed database, just with the wrong semantics.
 *
 * New spec (the schema declares the IDENTICAL twin): unique on
 * { organizationId: 1, weekKey: 1 }, partialFilterExpression
 * { weekKey: { $exists: true } } — only meter-mode documents (which always set
 * weekKey) are covered.
 *
 * Distinct name, NOT a drop-then-recreate-under-the-same-name swap (#3990's
 * approach does not apply here): because the OLD index is already live and
 * valid, giving the new spec the SAME default name
 * (`organizationId_1_weekKey_1`) would make mongoose's autoIndex — which now
 * runs BEFORE migrations and SURFACES build failures loudly (#3990's
 * `awaitIndexBuilds()`) — reject with IndexOptionsConflict (same name,
 * different options as the still-live old index) on the very FIRST boot after
 * this schema change deploys, crashing bootstrap before `migrations.run()`
 * ever executes. That would be a self-inflicted boot-crash loop: the migration
 * that is supposed to drop the old index never gets a chance to run. Naming
 * the new index `organizationId_1_weekKey_1_partial` lets autoIndex build it
 * ALONGSIDE the old one without conflict (two indexes on the same key under
 * different names coexist in MongoDB — mirrors the exact technique in
 * `modules/users/migrations/20260610120000-users-email-ci-unique-index.js`,
 * used there for the same class of problem: swapping a live unique index's
 * options without a name collision).
 *
 * Ordering:
 *   (a) Duplicate pre-check FIRST, ZERO writes. Group the meter shape
 *       (weekKey present) by (organizationId, weekKey), abort loud on any
 *       count > 1. Defensive: the OLD sparse index already enforced
 *       uniqueness among weekKey-bearing documents (sparse behaves correctly
 *       when the field IS present), so no duplicate should exist here in
 *       practice — but this migration must not assume that and must never
 *       silently swallow a violation if one somehow does.
 *   (b) Create the NEW partial index FIRST (idempotent — skipped if already
 *       exact-spec). Safe to do while the OLD index is still live: it only
 *       indexes documents where weekKey exists, and (a) already proved no
 *       duplicate exists among those. There is never a window without SOME
 *       uniqueness constraint on meter-mode documents.
 *   (c) Drop the OLD index (by its default name, or any other divergent
 *       same-key index) now that the NEW one is live and enforcing.
 * Idempotent on re-run: a second `up()` finds the new index already exact-spec
 * and the old index already absent — the skip-window fast path below makes it
 * a no-op read.
 *
 * Skip-window fast path: if the new index is already the exact target shape
 * AND the old index is already gone, the whole create/drop sequence is
 * skipped entirely. This is the common case on every boot after the first one
 * that ever ran this migration to completion on a given database (including
 * every other instance in a rolling deploy racing this same migration on the
 * SAME target database).
 *
 * Residual unguarded window (HONEST — not fully eliminated): a duplicate-key
 * error on the final createIndex call (a concurrent write landing a
 * genuine duplicate weekKey pair between the pre-check and the create) is
 * caught and converted into the same loud, actionable abort as (a) — never a
 * bare driver error — so the failure mode this migration produces is always
 * the documented "abort loud, remediate, re-run" path. `runMigration`
 * (lib/services/migrations.js) unclaims on throw, so the very next boot
 * retries, and (a)'s pre-check now sees the race-created duplicate and aborts
 * with full detail before touching the index at all.
 *
 * autoIndex race: mongoose autoIndex:true (the default — db.options sets no
 * override) builds the schema-declared twin (same name) on connect; identical
 * specs make the race benign. This migration is the AUTHORITATIVE creator +
 * old-index dropper on already-deployed databases (it owns the drop autoIndex
 * never performs — autoIndex only adds/rebuilds schema-declared indexes, it
 * never removes indexes the schema no longer declares).
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const usages = mongoose.connection.db.collection('billingusages');

  // ── (a) Duplicate pre-check FIRST — zero writes so far. `.aggregate()` on a
  // missing/empty collection just returns an empty result, so this is also
  // safe on a fresh database.
  const duplicates = await findWeekKeyDuplicates(usages);

  if (duplicates.length > 0) {
    // Emit only usage document ids — never organization identities — in
    // operator-facing errors.
    const sample = duplicates
      .slice(0, 10)
      .map((d) => `(${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
      .join('; ');
    throw new Error(
      `[migration] usage-weekkey-index-partial ABORTED: ${duplicates.length} duplicate meter-mode usage (organizationId, weekKey) group(s) would violate the unique index. ` +
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
      console.info('[migration] usage-weekkey-index-partial: billingusages collection does not exist yet — nothing to migrate');
      return;
    }
    throw err;
  }

  // ── Skip-window fast path ── If the new index is already the exact target
  // shape AND the old index is already gone, there is nothing left to do.
  const oldStillPresent = existing.some((ix) => ix.name === OLD_INDEX_NAME);
  if (existing.some(isExactTargetIndex) && !oldStillPresent) {
    console.info('[migration] usage-weekkey-index-partial: new index already matches the target spec and the old index is already gone — skipping entirely');
    return;
  }

  // ── (b) Create the NEW partial index FIRST (idempotent) — before dropping
  // the old one, so there is never a window without SOME uniqueness
  // constraint on meter-mode documents.
  if (!existing.some(isExactTargetIndex)) {
    try {
      await usages.createIndex(INDEX_KEY, {
        unique: true,
        name: NEW_INDEX_NAME,
        partialFilterExpression: { weekKey: { $exists: true } },
      });
      console.info('[migration] usage-weekkey-index-partial: created partial-unique index on (organizationId, weekKey)');
    } catch (err) {
      if (err?.code !== 11000) throw err;

      const raceDuplicates = await findWeekKeyDuplicates(usages);
      const sample = raceDuplicates.length > 0
        ? raceDuplicates
            .slice(0, 10)
            .map((d) => `(${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
            .join('; ')
        : `could not re-derive the offending pair(s) from a fresh aggregate — raw driver error: ${err.message}`;
      throw new Error(
        `[migration] usage-weekkey-index-partial ABORTED on index create: a duplicate (organizationId, weekKey) pair landed during migration — ` +
          `a concurrent write racing this migration. Remediate (delete/merge the duplicate rows) and re-run — the next boot's pre-check will catch this up front. Sample: ${sample}`,
      );
    }
  } else {
    console.info('[migration] usage-weekkey-index-partial: partial-unique index already present — skipping create');
  }

  // ── (c) Drop the OLD index (and any other divergent same-key index) now
  // that the new one is live and enforcing. ──
  for (const ix of existing) {
    if (ix.name === '_id_' || ix.name === NEW_INDEX_NAME) continue;
    if (sameKey(ix) || ix.name === OLD_INDEX_NAME) {
      await usages.dropIndex(ix.name);
      console.info(`[migration] usage-weekkey-index-partial: dropped legacy index '${ix.name}' (sparse, superseded by the partial index)`);
    }
  }
}

/**
 * Down: no-op (warn). The pre-fix state was a compound sparse index that
 * silently collapsed legacy usage to one document per organization forever —
 * restoring it would reintroduce the bug. Rollback = revert the schema
 * declaration deliberately, then drop the partial index by hand if truly
 * needed.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] usage-weekkey-index-partial DOWN: no-op; drop the (organizationId, weekKey) partial index manually only alongside a deliberate schema revert',
  );
}
