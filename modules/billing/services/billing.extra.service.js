/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';

/**
 * @function creditPack
 * @description Credit extra meter units from a purchased pack.
 *              Looks up the pack definition from config.billing.packs by packId,
 *              computes expiresAt from pack.expiryDays (null if not set),
 *              and delegates to the repository for atomic idempotent write.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} packId - The pack identifier (must exist in config.billing.packs).
 * @param {string} stripeSessionId - Stripe checkout session ID (idempotency key).
 * @returns {Promise<{doc: Object, applied: boolean}>} Updated doc and whether the credit was applied.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const creditPack = async (orgId, packId, stripeSessionId) => {
  const packs = config?.billing?.packs ?? [];
  const pack = packs.find((p) => p.packId === packId);
  if (!pack) throw new Error(`Pack not found: ${packId}`);

  const amount = pack.meterUnits ?? pack.computeUnits;
  if (!amount || amount <= 0) throw new Error(`Pack ${packId} has no valid meterUnits`);

  let expiresAt = null;
  if (pack.expiryDays != null) {
    expiresAt = new Date(Date.now() + pack.expiryDays * 24 * 60 * 60 * 1000);
  }

  return BillingExtraBalanceRepository.creditPack(orgId, amount, stripeSessionId, expiresAt);
};

/**
 * @function debit
 * @description Debit meter units from the extra balance.
 *              Returns applied=false if balance is insufficient or refId already used.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} units - Meter units to debit (must be > 0).
 * @param {string} refId - Unique reference for this debit (idempotency key).
 * @returns {Promise<{doc: Object|null, applied: boolean}>} Updated doc and whether debit was applied.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const debit = (orgId, units, refId) =>
  BillingExtraBalanceRepository.debit(orgId, units, refId);

/**
 * @function getOrgBalanceContext
 * @description Return the current extra balance for an organization.
 * @param {string} orgId - The organization ObjectId (string).
 * @returns {Promise<number>} Current cached extras balance.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const getOrgBalanceContext = (orgId) =>
  BillingExtraBalanceRepository.getBalance(orgId);

/**
 * @function expireOldEntries
 * @description Sweep expired topup entries for an organization and push
 *              corresponding expiration ledger entries to reduce the balance.
 *              Idempotent: re-running does not create duplicate expiration entries.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @returns {Promise<number>} Number of expiration entries added.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const expireOldEntries = (orgId) =>
  BillingExtraBalanceRepository.addExpirationEntries(orgId, new Date());

/**
 * @function refundPartial
 * @description Proportionally refund meter units when a pack purchase is partially refunded.
 *              Formula: refundUnits = round((amountRefundedCents / 100) / pack.priceUsd * pack.meterUnits)
 *              Pushes a negative 'refund' ledger entry. The balance may go negative if the
 *              original units were already consumed — this is the correct economic reflection
 *              (the debt persists until the next creditPack replenishes it).
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} stripeSessionId - Stripe session ID of the original purchase (to find the pack).
 * @param {number} amountRefundedCents - Amount refunded in cents (integer).
 * @param {string|undefined} [packId] - Optional pack identifier from Stripe metadata for exact correlation.
 * @param {string} stripeRefundId - Stripe refund object ID (e.g. rf_xxx) — used as primary idempotency key.
 * @returns {Promise<{doc: Object|null, applied: boolean, refundUnits: number, reason?: string}>}
 *          `reason` is present only when `applied === false`: 'meter_mode_disabled' | 'invalid_org' |
 *          'pack_not_found' | 'ambiguous_pack_match'.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const refundPartial = async (orgId, stripeSessionId, amountRefundedCents, packId, stripeRefundId) => {
  if (!config?.billing?.meterMode) {
    return { doc: null, applied: false, reason: 'meter_mode_disabled', refundUnits: 0 };
  }

  // Find the topup ledger entry for this session to identify the pack
  const doc = await BillingExtraBalanceRepository.getOrCreate(orgId);
  if (!doc) return { doc: null, applied: false, reason: 'invalid_org', refundUnits: 0 };
  const topupEntry = doc.ledger?.find(
    (e) => e.kind === 'topup' && e.stripeSessionId === stripeSessionId,
  );

  if (!topupEntry) {
    // No matching topup — nothing to refund
    return { doc, applied: false, refundUnits: 0 };
  }

  const packs = config?.billing?.packs ?? [];
  let matchingPack;

  if (packId) {
    matchingPack = packs.find((p) => p.packId === packId);
    if (!matchingPack) {
      return { doc, applied: false, reason: 'pack_not_found', refundUnits: 0 };
    }
  } else {
    const matchingPacks = packs.filter(
      (p) => (p.meterUnits ?? p.computeUnits) === topupEntry.amount,
    );

    if (matchingPacks.length !== 1) {
      // Ambiguous or unknown pack — cannot compute proportional refund safely.
      return { doc, applied: false, reason: 'ambiguous_pack_match', refundUnits: 0 };
    }

    matchingPack = matchingPacks[0];
  }

  let refundUnits;
  if (matchingPack.priceUsd && matchingPack.priceUsd > 0) {
    const packUnits = matchingPack.meterUnits ?? matchingPack.computeUnits;
    refundUnits = Math.round((amountRefundedCents / 100 / matchingPack.priceUsd) * packUnits);
  } else {
    // Fallback: proportional to topup amount (assume full refund if no priceUsd)
    refundUnits = topupEntry.amount;
  }

  if (refundUnits <= 0) return { doc, applied: false, refundUnits: 0 };

  // Use Stripe refund ID (globally unique per refund object) as the primary idempotency component.
  // Fallback to session+amount+topup when stripeRefundId is absent (legacy callers / tests).
  const refundRefId = stripeRefundId
    ? `refund-${stripeRefundId}-${topupEntry._id}`
    : `refund-${stripeSessionId}-${amountRefundedCents}-${topupEntry._id ?? Date.now()}`;

  // Delegate atomic write to repository — no mongoose import in service layer.
  const { doc: updatedDoc, applied } = await BillingExtraBalanceRepository.refundPartial(
    orgId,
    stripeSessionId,
    refundUnits,
    refundRefId,
  );

  if (applied) return { doc: updatedDoc, applied: true, refundUnits };
  return { doc, applied: false, refundUnits: 0 };
};

/**
 * @function listLedger
 * @description Return a paginated slice of the ledger for an organization.
 *              Entries are returned in reverse chronological order (newest first).
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Object} [options={}] - Pagination options.
 * @param {number} [options.page=1] - 1-based page number.
 * @param {number} [options.limit=20] - Entries per page.
 * @returns {Promise<{entries: Object[], total: number, balance: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const listLedger = async (orgId, { page = 1, limit = 20 } = {}) => {
  const doc = await BillingExtraBalanceRepository.getOrCreate(orgId);
  if (!doc) return { entries: [], total: 0, balance: 0 };
  const ledger = doc.ledger ?? [];
  const total = ledger.length;

  // Sort descending by at date
  const sorted = [...ledger].sort((a, b) => new Date(b.at) - new Date(a.at));
  const start = (page - 1) * limit;
  const entries = sorted.slice(start, start + limit);

  return { entries, total, balance: doc.cachedBalance ?? 0 };
};

export default {
  creditPack,
  debit,
  getOrgBalanceContext,
  expireOldEntries,
  refundPartial,
  listLedger,
};
