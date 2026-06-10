/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const INVITE_TOKEN_INDEX = 'inviteToken_1';

/**
 * Migration: Remove the organization email-invite feature's leftover data.
 *
 * The org-owned email-invite flow (`status:'invited'` memberships carrying an
 * `inviteToken` / `invitedEmail` / `inviteExpiresAt`) has been deleted. This
 * migration cleans up any residual data:
 *   - deletes leftover `invited` memberships (often `userId:null` orphans that
 *     would otherwise dangle with no corresponding user);
 *   - unsets the now-removed invite fields on any surviving membership;
 *   - drops the sparse `inviteToken_1` index that backed invite lookups.
 *
 * Uses the RAW collection driver (not the Mongoose model) for both writes: the
 * schema no longer declares `inviteToken` / `invitedEmail` / `inviteExpiresAt`,
 * so a model-based `updateMany` would have strict-mode strip those keys from the
 * `$unset` operator — the driver would receive no `$unset` and the legacy fields
 * would survive forever (the migration would record as executed having changed
 * nothing). Same gotcha the billing migrations document (see
 * `20260502100000-*` and `20260503000200-slim-subscription-drop-period-fields`).
 *
 * Idempotent: re-running is a no-op (no `invited` rows / no invite fields / the
 * index already absent).
 * @returns {Promise<void>} Resolves when the cleanup has completed.
 */
export async function up() {
  // Raw collection driver so neither the deleteMany filter nor the $unset is
  // stripped by strict-mode schema enforcement (the model no longer declares
  // the invite fields). Model `Membership` → default collection `memberships`.
  const db = mongoose.connection.db;
  const memberships = db.collection('memberships');

  // Org email-invite removed; leftover INVITED rows (often userId:null) become orphans → delete.
  await memberships.deleteMany({ status: 'invited' });

  await memberships.updateMany(
    { $or: [{ inviteToken: { $exists: true } }, { invitedEmail: { $exists: true } }, { inviteExpiresAt: { $exists: true } }] },
    { $unset: { inviteToken: '', invitedEmail: '', inviteExpiresAt: '' } },
  );

  // Check-then-act so absence is the expected path (not an error to swallow) and
  // either outcome is observable. listIndexes throws NamespaceNotFound on a fresh
  // DB with no memberships collection — treat that as "nothing to drop".
  let indexes = [];
  try {
    indexes = await memberships.indexes();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
      console.info('[migration] drop-org-invited-memberships: memberships collection does not exist yet — nothing to drop');
      return;
    }
    throw err;
  }

  if (indexes.some((ix) => ix.name === INVITE_TOKEN_INDEX)) {
    await memberships.dropIndex(INVITE_TOKEN_INDEX);
    console.info('[migration] drop-org-invited-memberships: dropped legacy inviteToken_1 index');
  } else {
    console.info('[migration] drop-org-invited-memberships: inviteToken_1 index already absent — skipping drop');
  }
}

/**
 * No-op down migration. The dropped data/index cannot be meaningfully restored.
 * @returns {void}
 */
export function down() { console.warn('[migration] drop-org-invited-memberships DOWN: no-op'); }
