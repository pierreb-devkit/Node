/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const PLAIN_INDEX = 'email_1';
// MUST match the schema's explicit index name (users.model.mongoose.js) so autoIndex
// /syncIndexes see this exact index and stay idempotent — and MUST differ from the
// legacy default `email_1` so the collation index and the legacy plain index can
// coexist transiently (Mongo rejects two indexes sharing a name).
const CI_INDEX = 'email_ci_unique';

/**
 * Migration: case-insensitive unique email index (E3).
 *
 * Replaces the legacy case-SENSITIVE `email_1` unique index with a collation
 * (`{ locale:'en', strength:2 }`) unique index so `User@x.com` and `user@x.com`
 * can never coexist. This backs the invite single-use backstop (case-variant
 * concurrent signups collide instead of creating two accounts) and OAuth
 * account-linking by email.
 *
 * Safety / ordering:
 *   (a) Pre-check for existing case-variant duplicate emails. If any exist we
 *       ABORT (throw) WITHOUT touching indexes — auto-merging accounts is a
 *       destructive product decision, not a migration's call. The thrown error
 *       lists the colliding groups so an operator can remediate, then re-run.
 *   (a2) Normalize legacy mixed-case emails (post-dup-check, so it can never collide).
 *   (b) Create the collation unique index FIRST, THEN drop the plain `email_1`.
 *       There is never a window without a unique constraint on email.
 *   (c) Idempotent: re-running after success is a no-op (the CI index already
 *       exists; the plain index is already gone).
 *
 * autoIndex race: Mongoose `autoIndex:true` (the default — db.options sets no
 * override) begins building the schema-declared index on connect, which can race
 * this migration. The schema declares the SAME collation index, so whichever wins
 * the race the end state is identical and `syncIndexes()` stays idempotent (it
 * sees one matching index, nothing to create/drop). This migration is the
 * AUTHORITATIVE creator and additionally drops the legacy plain index that the
 * schema no longer declares.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const User = mongoose.model('User');
  const collection = User.collection;

  // ── (a) Pre-check: refuse to run if case-variant duplicate emails exist ──
  // Group by the lowercased email; any group with >1 distinct stored email (or
  // >1 document) is a collision the unique collation index would reject.
  const duplicates = await collection
    .aggregate([
      { $match: { email: { $type: 'string' } } },
      { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 }, ids: { $push: '$_id' }, emails: { $addToSet: '$email' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length > 0) {
    // Emit only IDs/counts — never log raw emails (PII) in operator-facing errors.
    const sample = duplicates
      .slice(0, 10)
      .map((d) => `group:${d._id.slice(0, 6)}… (${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
      .join('; ');
    throw new Error(
      `[migration] users-email-ci-unique-index ABORTED: ${duplicates.length} case-variant duplicate email group(s) would violate the unique collation index. ` +
        `Remediate (merge/delete the duplicate accounts) before re-running — this migration will NOT auto-merge accounts. Sample (IDs only): ${sample}`,
    );
  }

  // ── (a2) Normalize legacy mixed-case emails to lowercase ──
  // Post-chain every lookup lowercases its input (schema `lowercase:true` +
  // repository normalizeEmail) and a plain findOne without per-query collation
  // is a BINARY match — a legacy mixed-case row would be unreachable (signin,
  // password-forgot, OAuth linkProviderByEmail, the invitations E9 guard all
  // miss it). The dup pre-check above guarantees lowercasing cannot collide.
  // Pipeline-update form so $toLower runs server-side; idempotent (the filter
  // only matches rows still containing an uppercase letter).
  const normalized = await collection.updateMany(
    { email: { $type: 'string', $regex: /[A-Z]/ } },
    [{ $set: { email: { $toLower: '$email' } } }],
  );
  if (normalized.modifiedCount > 0) {
    console.info(`[migration] users-email-ci-unique-index: lowercased ${normalized.modifiedCount} legacy mixed-case email(s)`);
  }

  // Snapshot existing indexes once (listIndexes throws if the collection does not
  // exist yet — tolerate that: a fresh DB has no users collection and autoIndex /
  // syncIndexes will create the CI index from the schema declaration).
  let existing = [];
  try {
    existing = await collection.listIndexes().toArray();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      console.info('[migration] users-email-ci-unique-index: users collection does not exist yet — nothing to migrate');
      return;
    }
    throw err;
  }
  // Require the exact expected shape: name, key, uniqueness, AND collation spec.
  // A spec-matching index with the wrong name would still conflict on re-creation
  // (Mongo rejects two indexes on the same key pattern) — guard both to be explicit.
  const hasCi = existing.some(
    (ix) =>
      ix.name === CI_INDEX &&
      ix.key?.email === 1 &&
      ix.unique === true &&
      ix.collation?.locale === 'en' &&
      ix.collation?.strength === 2,
  );
  const hasPlain = existing.some((ix) => ix.name === PLAIN_INDEX);

  // ── (b) Create the collation unique index FIRST (idempotent) ──
  if (!hasCi) {
    await collection.createIndex({ email: 1 }, { unique: true, name: CI_INDEX, collation: { locale: 'en', strength: 2 } });
    console.info('[migration] users-email-ci-unique-index: created collation unique index on email');
  } else {
    console.info('[migration] users-email-ci-unique-index: collation unique index already present — skipping create');
  }

  // ── (b) THEN drop the legacy plain `email_1` (only after the CI index exists) ──
  if (hasPlain) {
    await collection.dropIndex(PLAIN_INDEX);
    console.info('[migration] users-email-ci-unique-index: dropped legacy plain email_1 index');
  } else {
    console.info('[migration] users-email-ci-unique-index: legacy email_1 index already absent — skipping drop');
  }
}

/**
 * Down: no-op (warn). Reverting to a case-sensitive unique index could fail if
 * case-variant rows were created under the CI index, and it would re-introduce
 * the original bug. Rollback requires reverting the code (schema declaration +
 * repository email normalization) deliberately, not an automated down-migration.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] users-email-ci-unique-index DOWN: no-op; revert the case-insensitive email index by reverting the code (schema + repository) deliberately',
  );
}
