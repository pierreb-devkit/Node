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
 * @returns {boolean} true when the index key is exactly { organizationId:1, month:1 }
 */
const sameKey = (ix) => {
  const keys = Object.keys(ix.key || {});
  return keys.length === 2 && keys[0] === 'organizationId' && keys[1] === 'month'
    && ix.key.organizationId === 1 && ix.key.month === 1;
};

/**
 * @desc Exact-spec match helper: `sameKey` PLUS the correct name, uniqueness,
 * and partialFilterExpression — the full target shape this migration installs.
 * @param {Object} ix - an index document from listIndexes()
 * @returns {boolean} true when ix is already the fully-installed target index
 */
const isExactTargetIndex = (ix) =>
  sameKey(ix) && ix.name === INDEX_NAME && ix.unique === true && ix.partialFilterExpression?.legacyPeriod?.$exists === true;

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
 * Skip-window fast path (#3990 review): before doing any of (b)-(d), if the
 * index is ALREADY the exact target shape (name/key/unique/partialFilter —
 * see `isExactTargetIndex`) AND a cheap existence probe finds no legacy
 * document still missing `legacyPeriod`, the whole drop→backfill→recreate
 * sequence is skipped. This is the common case on every boot after the first
 * one that ever ran this migration to completion on a given database
 * (including every other instance in a rolling deploy racing this same
 * migration on the SAME target database) — steady state never re-opens the
 * window below.
 *
 * Residual unguarded window (HONEST — not fully eliminated): the fast path
 * above only fires once the database has already converged. On the FIRST
 * successful run against a given database (or any run that still has legacy
 * documents to backfill), (b)-(d) still execute and there is a real window
 * with no unique constraint live on `billingusages`. Migrations run at boot
 * BEFORE `listen()`, so THIS instance is not serving yet — but on a rolling
 * deploy, previously-deployed instances of the OLD code are still serving and
 * writing `legacyPeriod: true` on insert (racy upsert, pre-#3990 behaviour).
 * If two such writes for the same (organizationId, month) land in the window,
 * step (d)'s `createIndex` throws a raw duplicate-key error (E11000) instead
 * of the pre-check's actionable message. That failure is now CAUGHT and
 * converted into the same loud, actionable abort as (a) — re-deriving and
 * naming the offending pair(s) — so the failure mode this migration produces
 * is always the documented "abort loud, remediate, re-run" path, never a bare
 * driver error. `runMigration` (lib/services/migrations.js) unclaims on
 * throw, so the very next boot retries, and (a)'s pre-check now sees the
 * race-created duplicate and aborts with full detail before touching the
 * index at all.
 * For a STRICT guarantee (no window at all, not even a caught one), run this
 * deploy during a maintenance window or scale to a single instance before
 * rolling forward — the same operational note as other index-swap migrations
 * in this file's project (see MIGRATIONS.md, "Boot awaits index builds;
 * billing usage month-index partial-filter fix"). A fully atomic swap was
 * evaluated (build the new spec under a temporary name, cut over, drop the
 * old one — the trick the email-CI-unique-index migration uses) and rejected
 * here: that trick only works because the OLD and NEW specs there could
 * coexist under two different index NAMES with the SAME constraint semantics
 * throughout; here the schema declares one canonical name
 * (`organizationId_1_month_1`) for both the pre-existing (never-built, since
 * it was invalid) and the fixed spec, and the actual goal of the drop is not
 * a rename but making way for the backfill write itself — there is no second
 * index that can hold the constraint meanwhile.
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

  // ── Skip-window fast path (#3990 review) ── If the index is already the
  // exact target shape, probe (cheap, read-only) whether any legacy document
  // still needs the `legacyPeriod` backfill. When both hold, (b)-(d) below —
  // and the unguarded window they open — are entirely unnecessary: there is
  // nothing left to write, so nothing can race a live constraint. This is the
  // common case on every boot after the first one that ever converged this
  // database (see the migration header for the residual window that remains
  // when this fast path does NOT apply).
  if (existing.some(isExactTargetIndex)) {
    const pending = await usages.findOne(
      { weekKey: { $exists: false }, legacyPeriod: { $exists: false } },
      { projection: { _id: 1 } },
    );
    if (!pending) {
      console.info('[migration] usage-month-index-partial-filter: index already matches the target spec and nothing left to backfill — skipping drop/recreate window entirely');
      return;
    }
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
  // A concurrent old-instance write (see migration header: previously-deployed
  // pods still serving during a rolling deploy) can land a duplicate
  // (organizationId, month) pair in the (b)-(d) window despite (a)'s
  // pre-check, surfacing here as a raw E11000 on index build. Re-derive and
  // name the offending pair(s) so this failure mode is always the same loud,
  // actionable abort as (a) — never a bare driver error — and let the caller
  // (lib/services/migrations.js#runMigration) unclaim so the next boot's (a)
  // pre-check catches it up front.
  try {
    await usages.createIndex(INDEX_KEY, {
      unique: true,
      name: INDEX_NAME,
      partialFilterExpression: { legacyPeriod: { $exists: true } },
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const raceDuplicates = await usages
      .aggregate([
        { $match: { legacyPeriod: { $exists: true } } },
        { $group: { _id: { organizationId: '$organizationId', month: '$month' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();
    const sample = raceDuplicates.length > 0
      ? raceDuplicates
          .slice(0, 10)
          .map((d) => `(${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
          .join('; ')
      : `could not re-derive the offending pair(s) from a fresh aggregate — raw driver error: ${err.message}`;
    throw new Error(
      `[migration] usage-month-index-partial-filter ABORTED on index create: a duplicate (organizationId, month) pair landed during the drop→recreate window — ` +
        `a concurrent write from a still-serving old instance on a rolling deploy (see migration header). ` +
        `Remediate (delete/merge the duplicate rows) and re-run — the next boot's pre-check will catch this up front. Sample: ${sample}`,
    );
  }
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
