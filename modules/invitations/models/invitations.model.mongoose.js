/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import { INVITATION_STATUSES } from '../lib/invitations.constants.js';
import { MEMBERSHIP_ROLES } from '../../organizations/lib/organizations.constants.js';

const Schema = mongoose.Schema;

/**
 * Signup Invitation Schema — a single-use, expiring invite that re-opens signup
 * for a specific email when public signup is disabled or capped.
 *
 * Lifecycle (status):
 *   - `pending`  — issued, not yet consumed (the only state that opens the gate).
 *   - `accepted` — a signup finalized against it (acceptedAt/acceptedUserId set).
 *   - `revoked`  — soft-deleted by an admin (revokedAt set); never re-opens the gate.
 *
 * Two-phase claim (E2): `consumingAt` is set when a signup atomically CLAIMS the
 * invite (before the user is created) and cleared on release if that signup fails.
 * A claimed-but-unfinalized invite (consumingAt set, acceptedAt null) must read as
 * INVALID — otherwise a concurrent path or the email-resolved OAuth path could
 * re-accept it and bypass single-use (see findValid/findValidByEmail).
 */
const InvitationMongoose = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true },
    invitedBy: { type: Schema.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    // E2 two-phase claim/finalize — timestamp the in-flight claim (set before the
    // user is created, cleared on release if the signup fails). A stale claim (no
    // acceptedAt after N min) is swept lazily so a crash between claim and finalize
    // never permanently burns the invite.
    consumingAt: { type: Date, default: null },
    // E2 finalize — who/when the signup completed (also read by the P8 referral phase).
    acceptedAt: { type: Date, default: null },
    acceptedUserId: { type: Schema.ObjectId, ref: 'User', default: null },
    // E8 soft-delete revoke — preserve invitedBy/acceptedUserId for referral tracking
    // instead of hard-deleting; a revoked invite never re-opens the gate.
    revokedAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(INVITATION_STATUSES), default: INVITATION_STATUSES.PENDING },
    // Organization target — an org owner/admin invited this email INTO their organization
    // with `role`. Both null for a platform (beta-gate / referral) invite, which behaves
    // exactly as before. An org invite never stamps referredBy and earns no referral reward.
    organizationId: { type: Schema.ObjectId, ref: 'Organization', default: null },
    role: { type: String, enum: [...Object.values(MEMBERSHIP_ROLES), null], default: null },
  },
  { timestamps: true },
);

InvitationMongoose.index({ token: 1 }, { unique: true });
InvitationMongoose.index({ email: 1 });
// #3842 — referral queries hit invitedBy (reconcile cron + future referral lists).
InvitationMongoose.index({ invitedBy: 1 });
// An organization's pending invites (org members dialog) + the org-removal revoke.
InvitationMongoose.index({ organizationId: 1, status: 1 });

/**
 * @desc Return document id as hex string
 * @this {Object} Mongoose Invitation document
 * @returns {String} hex string id
 */
function addID() {
  return this._id.toHexString();
}
InvitationMongoose.virtual('id').get(addID);
InvitationMongoose.set('toJSON', { virtuals: true });

mongoose.model('Invitation', InvitationMongoose);
