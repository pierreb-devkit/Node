/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const INDEX_KEY = { organizationId: 1, status: 1 };

/**
 * Migration: make the invitation organization target explicit on stored data.
 *
 * Invitations gain an optional organization target (`organizationId` + `role`, both
 * default null: null = a platform invite, behaving exactly as before). Rows written
 * before the change carry neither field; this backfills `organizationId: null` and
 * `role: null` on them, so every stored invitation states its target, and builds the
 * `{ organizationId: 1, status: 1 }` index the org list + org-removal revoke read.
 *
 * Raw collection driver (house migration style — independent of model registration).
 * Idempotent: each backfill matches only rows where the field is ABSENT (a row already
 * carrying an org target is never touched), and `createIndex` with the same key/options
 * is a no-op once the index exists.
 * @returns {Promise<void>} Resolves when the backfill and the index are done.
 */
export async function up() {
  const invitations = mongoose.connection.db.collection('invitations');

  const org = await invitations.updateMany({ organizationId: { $exists: false } }, { $set: { organizationId: null } });
  const role = await invitations.updateMany({ role: { $exists: false } }, { $set: { role: null } });
  await invitations.createIndex(INDEX_KEY);

  console.info(
    `[migration] invitation-org-target: organizationId=null on ${org?.modifiedCount ?? 0}, role=null on ${role?.modifiedCount ?? 0} invitation(s); index { organizationId: 1, status: 1 } ensured`,
  );
}

/**
 * Down migration: drop the index. The null fields stay — they match the schema
 * defaults, and unsetting them could not tell backfilled rows from new ones.
 * @returns {Promise<void>} Resolves when the index is dropped (or was absent).
 */
export async function down() {
  const invitations = mongoose.connection.db.collection('invitations');
  try {
    await invitations.dropIndex('organizationId_1_status_1');
  } catch (err) {
    if (err?.codeName !== 'IndexNotFound' && err?.codeName !== 'NamespaceNotFound') throw err;
  }
  console.warn('[migration] invitation-org-target DOWN: dropped index { organizationId: 1, status: 1 }');
}
