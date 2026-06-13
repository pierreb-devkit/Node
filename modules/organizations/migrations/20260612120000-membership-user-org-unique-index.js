/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const INDEX_NAME = 'user_org_unique';
const INDEX_KEY = { userId: 1, organizationId: 1 };

/**
 * @desc Exact-key match helper: a two-field index keyed (userId:1, organizationId:1)
 * in that order. Order-aware so the (organizationId, userId) prefix indexes are
 * never touched.
 * @param {Object} ix - an index document from listIndexes()
 * @return {boolean} true when the index key is exactly { userId:1, organizationId:1 }
 */
const sameKey = (ix) => {
  const keys = Object.keys(ix.key || {});
  return keys.length === 2 && keys[0] === 'userId' && keys[1] === 'organizationId'
    && ix.key.userId === 1 && ix.key.organizationId === 1;
};

/**
 * Migration: working (userId, organizationId) partial-unique membership index (#3841).
 *
 * The schema previously declared partialFilterExpression
 * `{ userId: { $exists: true, $ne: null } }` — MongoDB does NOT support `$ne` in a
 * partialFilterExpression, so server-side creation always failed. Mongoose autoIndex
 * reports that failure on the model's 'index' event, where nothing listens, so the
 * index NEVER existed on any deployed database and the duplicate-membership guard
 * ran on application code alone (racy findOne-then-create in addMember /
 * createJoinRequest).
 *
 * New spec (the schema declares the IDENTICAL twin): unique on
 * { userId: 1, organizationId: 1 }, partialFilterExpression
 * { userId: { $type: 'objectId' } }. `$type` is a supported partial-index operator
 * and preserves the original intent: `userId: null` rows are BSON type null, not
 * objectId, so they stay excluded and may repeat per organization.
 *
 * Safety / ordering:
 *   (a) Pre-check for existing duplicate (userId, organizationId) pairs that would
 *       violate the unique index. If any exist we ABORT (throw) WITHOUT touching
 *       indexes — picking which duplicate row wins is an operator decision, not a
 *       migration's call. The thrown error lists document ids only (PII-safe).
 *   (b) Drop any divergent index first: a same-key index under another name
 *       (phantom/legacy spec) or a namesake whose options drifted — either would
 *       conflict with or shadow the canonical index. Unlike the email-index
 *       migration there is no "window without a constraint" to protect: the
 *       constraint never materialized anywhere (that IS the bug), and dropping
 *       first avoids an IndexOptionsConflict on create.
 *   (c) Create `user_org_unique`. Idempotent: re-running after success is a no-op.
 *
 * autoIndex race: mongoose autoIndex:true (the default — db.options sets no
 * override) builds the schema-declared twin on connect; identical specs make the
 * race benign and syncIndexes() idempotent. This migration is the AUTHORITATIVE
 * creator.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const memberships = mongoose.connection.db.collection('memberships');

  // ── (a) Pre-check: refuse to run if duplicate (userId, organizationId) pairs exist ──
  // Scope to rows the partial index will cover (userId is an ObjectId): null-userId
  // rows are excluded by the partialFilterExpression and may legitimately repeat.
  const duplicates = await memberships
    .aggregate([
      { $match: { userId: { $type: 'objectId' } } },
      { $group: { _id: { userId: '$userId', organizationId: '$organizationId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length > 0) {
    // Emit only membership document ids — never user/org identities — in
    // operator-facing errors.
    const sample = duplicates
      .slice(0, 10)
      .map((d) => `(${d.count} docs, ids: ${d.ids.slice(0, 3).join(',')}${d.ids.length > 3 ? ',…' : ''})`)
      .join('; ');
    throw new Error(
      `[migration] membership-user-org-unique-index ABORTED: ${duplicates.length} duplicate membership (userId, organizationId) group(s) would violate the unique index. ` +
        `Remediate (delete/merge the duplicate rows) before re-running — this migration will NOT pick winners. Sample (ids only): ${sample}`,
    );
  }

  // Snapshot existing indexes once (listIndexes throws if the collection does not
  // exist yet — tolerate that: a fresh DB has no memberships collection and
  // autoIndex / syncIndexes will create the index from the schema declaration).
  let existing = [];
  try {
    existing = await memberships.listIndexes().toArray();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      console.info('[migration] membership-user-org-unique-index: memberships collection does not exist yet — nothing to migrate');
      return;
    }
    throw err;
  }

  // ── (b) Drop divergent indexes / detect the exact expected shape ──
  let hasIndex = false;
  for (const ix of existing) {
    if (ix.name === '_id_') continue;
    const keyMatches = sameKey(ix);
    const exactShape = keyMatches
      && ix.name === INDEX_NAME
      && ix.unique === true
      && ix.partialFilterExpression?.userId?.$type === 'objectId';
    if (exactShape) {
      hasIndex = true;
    } else if (keyMatches || ix.name === INDEX_NAME) {
      await memberships.dropIndex(ix.name);
      console.info(`[migration] membership-user-org-unique-index: dropped divergent index '${ix.name}'`);
    }
  }

  // ── (c) Create the partial-unique index (idempotent) ──
  if (!hasIndex) {
    await memberships.createIndex(INDEX_KEY, {
      unique: true,
      name: INDEX_NAME,
      partialFilterExpression: { userId: { $type: 'objectId' } },
    });
    console.info('[migration] membership-user-org-unique-index: created partial-unique index on (userId, organizationId)');
  } else {
    console.info('[migration] membership-user-org-unique-index: partial-unique index already present — skipping create');
  }
}

/**
 * Down: no-op (warn). The pre-fix state was a unique guard that silently never
 * existed — restoring "no index" would reintroduce the bug. Rollback = revert the
 * schema declaration deliberately, then drop `user_org_unique` by hand if truly
 * needed.
 *
 * @returns {void}
 */
export function down() {
  console.warn(
    '[migration] membership-user-org-unique-index DOWN: no-op; drop user_org_unique manually only alongside a deliberate schema revert',
  );
}
