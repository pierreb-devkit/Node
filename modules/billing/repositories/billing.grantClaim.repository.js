/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import { isDuplicateKeyError } from '../lib/billing.errors.js';

/**
 * Lazily resolves the BillingGrantClaim Mongoose model.
 * Deferred to keep unit tests importable before model registration.
 * @returns {import('mongoose').Model} The registered BillingGrantClaim model.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const BillingGrantClaim = () => mongoose.model('BillingGrantClaim');

/**
 * @function tryClaim
 * @description Atomically claim a creditGrant idempotencyKey using the unique index on
 *              `key` (see models/billing.grantClaim.model.mongoose.js for why this is a
 *              separate collection rather than a unique index on the ledger). No rollback,
 *              no TTL — the claim is permanent once inserted.
 * @param {string} key - The creditGrant idempotencyKey to claim.
 * @param {string} orgId - The organization ObjectId (string) attempting the claim.
 * @returns {Promise<{claimed: boolean, ownerOrgId?: string|null}>} `claimed: true` on a
 *              fresh claim. `claimed: false` with `ownerOrgId` set to the claim holder's
 *              org (string) when the key is already claimed — by this same org (a
 *              same-org retry/replay) or a different one (the cross-org conflict #4155
 *              exists to catch).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const tryClaim = async (key, orgId) => {
  try {
    await BillingGrantClaim().create({ key, organization: orgId, at: new Date() });
    return { claimed: true };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await BillingGrantClaim().findOne({ key }).lean();
    return { claimed: false, ownerOrgId: existing ? String(existing.organization) : null };
  }
};

export default {
  tryClaim,
};
