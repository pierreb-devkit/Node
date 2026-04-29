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
 * @returns {Promise<{doc: Object, applied: boolean, refundUnits: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const refundPartial = async (orgId, stripeSessionId, amountRefundedCents) => {
  // Find the topup ledger entry for this session to identify the pack
  const doc = await BillingExtraBalanceRepository.getOrCreate(orgId);
  const topupEntry = doc.ledger?.find(
    (e) => e.kind === 'topup' && e.stripeSessionId === stripeSessionId,
  );

  if (!topupEntry) {
    // No matching topup — nothing to refund
    return { doc, applied: false, refundUnits: 0 };
  }

  // Find the pack config to compute proportion
  const packs = config?.billing?.packs ?? [];
  // Try to match by amount (meterUnits) since we don't store packId on the entry
  const matchingPack = packs.find(
    (p) => (p.meterUnits ?? p.computeUnits) === topupEntry.amount,
  );

  let refundUnits;
  if (matchingPack && matchingPack.priceUsd && matchingPack.priceUsd > 0) {
    const packUnits = matchingPack.meterUnits ?? matchingPack.computeUnits;
    refundUnits = Math.round((amountRefundedCents / 100 / matchingPack.priceUsd) * packUnits);
  } else {
    // Fallback: proportional to topup amount (assume full refund if pack not found)
    refundUnits = topupEntry.amount;
  }

  if (refundUnits <= 0) return { doc, applied: false, refundUnits: 0 };

  const refundRefId = `refund-${stripeSessionId}-${amountRefundedCents}`;
  const refundEntry = {
    kind: 'refund',
    amount: -refundUnits,
    stripeSessionId,
    refId: refundRefId,
    at: new Date(),
  };

  // Atomic push with refId dedup — use repository via dynamic import to avoid circular
  const { default: mongoose } = await import('mongoose');
  const updatedDoc = await mongoose.model('BillingExtraBalance').findOneAndUpdate(
    {
      organization: orgId,
      'ledger.refId': { $ne: refundRefId },
    },
    {
      $push: { ledger: refundEntry },
      $inc: { cachedBalance: -refundUnits },
      $set: { cachedBalanceAt: new Date() },
    },
    { returnDocument: 'after' },
  );

  if (updatedDoc) return { doc: updatedDoc, applied: true, refundUnits };
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
  expireOldEntries,
  refundPartial,
  listLedger,
};
