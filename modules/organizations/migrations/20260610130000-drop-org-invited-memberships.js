/**
 * Module dependencies
 */
import mongoose from 'mongoose';

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
 * Idempotent: re-running is a no-op (no `invited` rows / no invite fields / the
 * index already absent — a missing index is swallowed).
 * @returns {Promise<void>} Resolves when the cleanup has completed.
 */
export async function up() {
  const Membership = mongoose.model('Membership');
  // Org email-invite removed; leftover INVITED rows (often userId:null) become orphans → delete.
  await Membership.deleteMany({ status: 'invited' });
  await Membership.updateMany(
    { $or: [{ inviteToken: { $exists: true } }, { invitedEmail: { $exists: true } }, { inviteExpiresAt: { $exists: true } }] },
    { $unset: { inviteToken: '', invitedEmail: '', inviteExpiresAt: '' } },
  );
  try { await Membership.collection.dropIndex('inviteToken_1'); } catch (e) { /* absent is fine */ }
}

/**
 * No-op down migration. The dropped data/index cannot be meaningfully restored.
 * @returns {void}
 */
export function down() { console.warn('[migration] drop-org-invited-memberships DOWN: no-op'); }
