/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const INDEX_NAME = 'processedAt_1';
const INDEX_KEY = { processedAt: 1 };
const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * @desc Exact-key match helper: a single-field index keyed (processedAt:1).
 * @param {Object} ix - an index document from listIndexes()
 * @returns {boolean} true when the index key is exactly { processedAt: 1 }
 */
const sameKey = (ix) => {
  const keys = Object.keys(ix.key || {});
  return keys.length === 1 && keys[0] === 'processedAt' && ix.key.processedAt === 1;
};

/**
 * @desc Exact-spec match helper: `sameKey` PLUS the correct name, TTL, and
 * partialFilterExpression — the full target shape this migration installs.
 * @param {Object} ix - an index document from listIndexes()
 * @returns {boolean} true when ix is already the fully-installed target index
 */
const isExactTargetIndex = (ix) =>
  sameKey(ix) && ix.name === INDEX_NAME && ix.expireAfterSeconds === TTL_SECONDS && ix.partialFilterExpression?.deadLetter?.$eq === false;

/**
 * Migration: dead-letter-preserving ProcessedStripeEvent TTL index (#4006).
 *
 * The schema's 30-day TTL index on `processedAt` gained
 * `partialFilterExpression: { deadLetter: { $eq: false } }` (dead-letter
 * documents are permanent rejections — Stripe was told to stop retrying —
 * and must NEVER be purged, or a later manual replay would re-process the
 * event as if new: double credit grants, double subscription resets) with NO
 * accompanying migration. On an already-deployed database still holding the
 * plain `processedAt_1` TTL index, autoIndex therefore hits
 * IndexOptionsConflict (code 85: same name, different options) on every
 * boot. Since #4004, `awaitIndexBuilds()` tolerates that conflict (logs
 * loudly, keeps serving on the stale live index) precisely so THIS migration
 * — the authoritative repair — can run right after in bootstrap. Without a
 * migration the tolerated conflict would persist forever, with the live
 * index still purging dead-letter documents after 30 days.
 *
 * Second latent defect fixed here (backfill): documents written before the
 * `deadLetter` field existed carry no `deadLetter` at all. A
 * partialFilterExpression uses query match semantics, and
 * `{ deadLetter: { $eq: false } }` does NOT match a missing field — such
 * documents would fall outside the new TTL entirely and never expire.
 * Backfilling `deadLetter: false` restores them into the TTL's scope; the
 * schema default covers every new write. Why the backfill is safe: `attempts`
 * / `lastError` / `lastErrorAt` / `deadLetter` all arrived together with the
 * dead-letter mechanism itself, and the schema default has materialized
 * `deadLetter: false` on every document written since — so a document missing
 * `deadLetter` predates the mechanism entirely (a plain success claim) and
 * cannot be a dead-lettered rejection. That reasoning holds for every code
 * path but not for manual surgery (hand edits, partial restores), so instead
 * of trusting it blindly the pre-check below ABORTS LOUD on the
 * impossible-by-code state: a document missing `deadLetter` that nevertheless
 * carries dead-letter-era evidence (`attempts > 0` or a non-null
 * `lastError`). Flipping such a document to `false` on a guess could mark a
 * genuine permanent rejection as purgeable — the TTL would expire it and a
 * later Stripe-dashboard replay would re-process the event as new (double
 * credit grant / double subscription reset). An operator classifies those by
 * hand; this migration will NOT pick.
 *
 * Same-name swap, deliberately NOT the distinct-name technique of
 * `20260728120000-fix-usage-weekkey-index-partial.js`: the schema already
 * ships this spec under the default name (`processedAt_1`), so renaming now
 * would churn every already-converged database (drop a correct index to
 * install an identical twin under a new name) just to spare legacy databases
 * a conflict that #4004 already made survivable. On a legacy database this
 * migration is REACHABLE only because of #4004 — the boot-tolerance fix must
 * be deployed with (or before) this migration.
 *
 * Ordering:
 *   (a) Skip-window fast path — live index already the exact target shape
 *       AND no document missing `deadLetter` → nothing to do (the common
 *       case on every boot after the first converged one, including fresh
 *       databases whose index autoIndex built correctly from day one).
 *   (a2) Ambiguity pre-check, ZERO writes — abort loud (see above) if any
 *       document missing `deadLetter` carries dead-letter-era evidence.
 *   (b) Backfill `deadLetter: false` onto field-less documents. Runs BEFORE
 *       the index swap so the recreated partial index covers them from its
 *       first build; safe at any point — no unique constraint is involved
 *       anywhere in this migration, so there is no duplicate-key window and
 *       no E11000 to convert (unlike the sibling unique-index migrations).
 *   (c) Drop any same-key or same-name index — the legacy plain TTL, a
 *       boot-built twin, or a divergent hand-fix under another name.
 *   (d) Recreate `processedAt_1` with the exact schema spec. The only cost
 *       of the (c)-(d) window is TTL expiry pausing for its duration, which
 *       is harmless — the TTL monitor only sweeps periodically anyway.
 * Idempotent on re-run: a second `up()` takes the fast path (a).
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const events = mongoose.connection.db.collection('processedstripeevents');

  // Snapshot existing indexes once (listIndexes throws if the collection does
  // not exist yet — tolerate that: a fresh DB has no processedstripeevents
  // collection and autoIndex will create the index from the schema declaration).
  let existing = [];
  try {
    existing = await events.listIndexes().toArray();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      console.info('[migration] processed-stripe-event-ttl-index-partial-filter: processedstripeevents collection does not exist yet — nothing to migrate');
      return;
    }
    throw err;
  }

  // ── (a) Skip-window fast path ── exact target spec already live AND no
  // document left outside the partial filter's reach → no-op read.
  if (existing.some(isExactTargetIndex)) {
    const pending = await events.findOne({ deadLetter: { $exists: false } }, { projection: { _id: 1 } });
    if (!pending) {
      console.info('[migration] processed-stripe-event-ttl-index-partial-filter: index already matches the target spec and nothing left to backfill — skipping entirely');
      return;
    }
  }

  // ── (a2) Ambiguity pre-check FIRST — zero writes so far. A document
  // missing `deadLetter` but carrying dead-letter-era evidence is impossible
  // via any code path (the fields shipped together and the schema default
  // materializes `deadLetter` on every write since) — if one exists anyway
  // (manual surgery, partial restore), guessing `false` could mark a genuine
  // permanent rejection purgeable. Abort loud; an operator classifies by hand.
  // Note `$ne: null` deliberately does NOT match a missing `lastError` —
  // pre-mechanism documents carry none of these fields and sail through.
  const ambiguous = await events
    .find(
      { deadLetter: { $exists: false }, $or: [{ attempts: { $gt: 0 } }, { lastError: { $ne: null } }] },
      { projection: { _id: 1 }, limit: 10 },
    )
    .toArray();
  if (ambiguous.length > 0) {
    throw new Error(
      `[migration] processed-stripe-event-ttl-index-partial-filter ABORTED: ${ambiguous.length}+ document(s) missing 'deadLetter' but carrying dead-letter-era evidence (attempts/lastError) — ` +
        `impossible via any code path, so this migration will NOT guess whether they are permanent rejections. ` +
        `Classify them by hand (set deadLetter true/false explicitly) and re-run. Sample ids: ${ambiguous.map((d) => d._id).join(',')}`,
    );
  }

  // ── (b) Backfill the discriminator onto pre-`deadLetter` documents ──
  // Safe now: (a2) proved every remaining field-less document predates the
  // dead-letter mechanism (a plain success claim), and a partial filter's
  // `$eq: false` never matches a missing field — without this they would
  // never expire.
  const backfillResult = await events.updateMany({ deadLetter: { $exists: false } }, { $set: { deadLetter: false } });
  if (backfillResult.modifiedCount > 0) {
    console.info(`[migration] processed-stripe-event-ttl-index-partial-filter: backfilled deadLetter:false on ${backfillResult.modifiedCount} document(s)`);
  }

  // ── (c) Drop the legacy/divergent index(es) ── the plain TTL under the
  // canonical name, or any same-key index living under another name.
  for (const ix of existing) {
    if (ix.name === '_id_') continue;
    if (sameKey(ix) || ix.name === INDEX_NAME) {
      await events.dropIndex(ix.name);
      console.info(`[migration] processed-stripe-event-ttl-index-partial-filter: dropped index '${ix.name}' (legacy plain TTL or divergent spec)`);
    }
  }

  // ── (d) Recreate the TTL index with the exact schema spec ── non-unique,
  // so no duplicate-key failure mode exists here; the (c)-(d) window only
  // pauses TTL expiry briefly.
  await events.createIndex(INDEX_KEY, {
    name: INDEX_NAME,
    expireAfterSeconds: TTL_SECONDS,
    partialFilterExpression: { deadLetter: { $eq: false } },
  });
  console.info('[migration] processed-stripe-event-ttl-index-partial-filter: created dead-letter-preserving TTL index on processedAt');
}

/**
 * Down: no-op (warn). The pre-fix state was a TTL index that purged
 * dead-letter documents — permanent rejections that must never be re-opened
 * to replay. Restoring it would reintroduce the double-processing risk.
 * Rollback = revert the schema declaration deliberately, then swap the index
 * by hand if truly needed. The `deadLetter: false` backfill is left in place
 * (it matches the schema default; no reader distinguishes backfilled from
 * organically-written `false`).
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] processed-stripe-event-ttl-index-partial-filter DOWN: no-op; swap the processedAt TTL index manually only alongside a deliberate schema revert',
  );
}
