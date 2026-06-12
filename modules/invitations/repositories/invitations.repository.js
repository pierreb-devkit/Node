/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Invitation = mongoose.model('Invitation');

/**
 * @desc Create an invitation document
 * @param {Object} doc - { email, token, expiresAt, invitedBy }
 * @returns {Promise<Object>} created invitation
 */
const create = (doc) => new Invitation(doc).save();

/**
 * @desc Find an invitation by its token (raw read — no validity filter).
 * @param {String} token
 * @returns {Promise<Object|null>}
 */
const findByToken = (token) => Invitation.findOne({ token }).exec();

/**
 * @desc Find the most recent VALID (pending, unconsumed, unexpired, not in-flight)
 * invitation for an email. Excludes rows with `consumingAt` set (a claimed-but-
 * unfinalized invite must NOT read as valid — otherwise the OAuth email-resolved
 * path could re-accept it and bypass single-use, E2). Only `status: 'pending'`
 * invites can open the gate (E8 revoke/accept are excluded).
 * @param {String} email - already-lowercased email
 * @returns {Promise<Object|null>}
 */
const findByEmail = (email) =>
  Invitation.findOne({ email, status: 'pending', usedAt: null, consumingAt: null, expiresAt: { $gt: new Date() } })
    .sort('-createdAt')
    .exec();

/**
 * @desc E2 — atomically CLAIM a pending, unclaimed invite by token. Stamps
 * `consumingAt` so a concurrent claim (or the email-resolved path) sees it as
 * in-flight/invalid. Returns the claimed doc, or null when nothing matched
 * (already claimed / used / revoked / accepted / expired) — the replay/double-accept guard.
 * Filter includes `usedAt:null` and `expiresAt:{$gt:now}` so the CAS step is
 * self-contained: even if a concurrent path accepted or the invite expired between
 * the caller's findValid and this claim, the CAS returns null and the caller throws.
 * @param {String} token
 * @returns {Promise<Object|null>} the claimed invite, or null if not claimable
 */
const claim = (token) =>
  Invitation.findOneAndUpdate(
    { token, status: 'pending', consumingAt: null, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumingAt: new Date() } },
    { returnDocument: 'after' },
  ).exec();

/**
 * @desc E2 — finalize an invite on full signup success: mark accepted + record the
 * user, and burn single-use (usedAt). Guarded on `acceptedAt:null` so finalize is
 * idempotent and cannot accept twice. Works for BOTH paths: the local path that
 * atomically CLAIMED first (consumingAt set — the claim is its replay guard) AND
 * the OAuth path that resolves by email without a claim (consumingAt null). It
 * intentionally does NOT require consumingAt to be set, so the unclaimed OAuth
 * accept still burns the invite. Also clears any consumingAt left by the claim.
 * @param {String} id
 * @param {String} userId - the just-created user's id
 * @returns {Promise<Object|null>} the finalized doc, or null if already accepted/missing
 */
const finalize = (id, userId) =>
  Invitation.findOneAndUpdate(
    { _id: id, acceptedAt: null, status: { $ne: 'revoked' } },
    { $set: { status: 'accepted', acceptedAt: new Date(), acceptedUserId: userId, usedAt: new Date() }, $unset: { consumingAt: 1 } },
    { returnDocument: 'after' },
  ).exec();

/**
 * @desc E2 — release a claimed-but-unfinalized invite so it can be retried
 * (clears `consumingAt`). No-ops on an already-finalized invite (acceptedAt guard).
 * @param {String} id
 * @returns {Promise<Object|null>} the released doc, or null if not releasable
 */
const release = (id) =>
  Invitation.findOneAndUpdate(
    { _id: id, acceptedAt: null },
    { $unset: { consumingAt: 1 } },
    { returnDocument: 'after' },
  ).exec();

/**
 * @desc E2 — lazily sweep stale claims: release any invite whose `consumingAt`
 * is older than `cutoff` and was never finalized (acceptedAt null). Recovers
 * invites orphaned by a crash between claim and finalize so they become reusable.
 * @param {Date} cutoff - claims older than this are released
 * @returns {Promise<Object>} bulk update result
 */
const releaseStaleClaims = (cutoff) =>
  Invitation.updateMany(
    { consumingAt: { $ne: null, $lt: cutoff }, acceptedAt: null },
    { $unset: { consumingAt: 1 } },
  ).exec();

/**
 * @desc List all invitations (admin), newest first
 * @returns {Promise<Array>}
 */
const list = () => Invitation.find({}).select('-token').populate('invitedBy', 'email firstName lastName').sort('-createdAt').exec();

/**
 * @desc List ALL accepted invitations, lean + minimal projection — the referral
 * reconcile cron (#3842) diffs them against the billing grant ledger keys and
 * back-fills misses. Scans all accepted (not just `invitedBy:{$ne:null}`): referee
 * grants exist even when invitedBy is null, so a referrer-only scan would miss
 * referee-only back-fills.
 * @returns {Promise<Array<{_id: Object, invitedBy: (Object|null), acceptedUserId: (Object|null)}>>}
 */
const findAccepted = () =>
  Invitation.find({ status: 'accepted' }, { invitedBy: 1, acceptedUserId: 1 }).lean().exec();

/**
 * @desc Get one invitation by id
 * @param {String} id
 * @returns {Promise<Object|null>}
 */
const get = (id) => (mongoose.Types.ObjectId.isValid(id) ? Invitation.findById(id).exec() : null);

/**
 * @desc E8 — soft-delete (revoke) an invitation by id: set status:'revoked' +
 * revokedAt instead of deleting, so invitedBy/acceptedUserId survive for the
 * referral phase. A revoked invite never re-opens the gate (findValid filters
 * on status:'pending').
 * @param {String} id
 * @returns {Promise<Object|null>} the revoked doc, or null when no such id
 */
const revoke = (id) =>
  Invitation.findOneAndUpdate(
    { _id: id },
    { $set: { status: 'revoked', revokedAt: new Date() } },
    { returnDocument: 'after' },
  ).exec();

export default { create, findByToken, findByEmail, claim, finalize, release, releaseStaleClaims, list, findAccepted, get, revoke };
