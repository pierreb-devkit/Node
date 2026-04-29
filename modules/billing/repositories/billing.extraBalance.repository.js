/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * Validate that orgId is a syntactically valid MongoDB ObjectId.
 * Returns false for malformed strings to avoid Mongoose CastError → 500.
 * @param {string} orgId - The organization id to validate.
 * @returns {boolean}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const isValidOrgId = (orgId) => mongoose.Types.ObjectId.isValid(orgId);

/**
 * @function BillingExtraBalance
 * @description Lazily resolves the BillingExtraBalance Mongoose model.
 *              Deferred to keep unit tests importable before model registration.
 * @returns {import('mongoose').Model} The registered BillingExtraBalance model.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const BillingExtraBalance = () => mongoose.model('BillingExtraBalance');

/**
 * @function getOrCreate
 * @description Upsert an empty balance document for the given organization.
 *              Returns the existing document if one already exists.
 *              Safe to call concurrently — uses findOneAndUpdate with upsert.
 * @param {string} orgId - The organization ObjectId (string).
 * @returns {Promise<Object>} The ExtraBalance document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const getOrCreate = (orgId) => {
  if (!isValidOrgId(orgId)) return Promise.resolve(null);
  return BillingExtraBalance().findOneAndUpdate(
    { organization: orgId },
    { $setOnInsert: { organization: orgId, ledger: [], cachedBalance: 0, cachedBalanceAt: new Date() } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
};

/**
 * @function creditPack
 * @description Atomically credit extra meter units from a Stripe pack purchase.
 *              Idempotent: if a ledger entry with the same stripeSessionId already
 *              exists, the update is a no-op and applied=false is returned.
 *              Uses a native-Mongo filter `ledger.stripeSessionId: { $ne: stripeSessionId }`
 *              so the idempotency check is part of the atomic update, not a separate read.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to credit (must be > 0).
 * @param {string} stripeSessionId - Stripe checkout session ID (idempotency key).
 * @param {Date|null} [expiresAt=null] - Optional expiry date for the topup entry.
 * @returns {Promise<{doc: Object, applied: boolean}>} Updated doc and whether the credit was applied.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const creditPack = async (orgId, amount, stripeSessionId, expiresAt = null) => {
  if (!isValidOrgId(orgId)) return { doc: null, applied: false };
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid argument: amount must be a positive finite number');
  if (typeof stripeSessionId !== 'string' || stripeSessionId.trim() === '') throw new Error('invalid argument: stripeSessionId must be a non-empty string');
  const entry = {
    kind: 'topup',
    amount,
    stripeSessionId,
    at: new Date(),
    ...(expiresAt ? { expiresAt } : {}),
  };

  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
      'ledger.stripeSessionId': { $ne: stripeSessionId },
    },
    {
      $push: { ledger: entry },
      $inc: { cachedBalance: amount },
      $set: { cachedBalanceAt: new Date() },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );

  if (doc) return { doc, applied: true };

  // No doc returned — the stripeSessionId already exists (idempotency hit).
  const existing = await BillingExtraBalance().findOne({ organization: orgId }).lean();
  return { doc: existing, applied: false };
};

/**
 * @function debit
 * @description Atomically debit meter units from the extra balance.
 *              Guards: (1) cachedBalance >= amount, (2) no existing ledger entry with refId.
 *              Both checks are in the atomic filter — no TOCTOU.
 *              Returns applied=false if balance is insufficient OR refId already used.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to debit (must be > 0).
 * @param {string} refId - Unique reference for this debit (idempotency key).
 * @returns {Promise<{doc: Object|null, applied: boolean}>} Updated doc and whether debit was applied.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const debit = async (orgId, amount, refId) => {
  if (!isValidOrgId(orgId)) return { doc: null, applied: false };
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid argument: amount must be a positive finite number');
  if (typeof refId !== 'string' || refId.trim() === '') throw new Error('invalid argument: refId must be a non-empty string');
  const entry = {
    kind: 'debit',
    amount: -amount,
    refId,
    at: new Date(),
  };

  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
      cachedBalance: { $gte: amount },
      'ledger.refId': { $ne: refId },
    },
    {
      $push: { ledger: entry },
      $inc: { cachedBalance: -amount },
      $set: { cachedBalanceAt: new Date() },
    },
    { returnDocument: 'after' },
  );

  if (doc) return { doc, applied: true };
  return { doc: null, applied: false };
};

/**
 * @function addExpirationEntries
 * @description Sweep topup entries that have expired and push matching expiration
 *              ledger entries to reduce cachedBalance.
 *              Idempotent: each topup entry can only produce one expiration entry
 *              (keyed by 'expire-<entryId>'). Re-running this method on already-expired
 *              entries is a no-op because the refId filter excludes already-handled entries.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Date} now - The current timestamp used as the expiry cutoff.
 * @returns {Promise<number>} Number of expiration entries added.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const addExpirationEntries = async (orgId, now) => {
  if (!isValidOrgId(orgId)) return 0;
  // Read the doc to find expired topups without a corresponding expiration entry.
  const doc = await BillingExtraBalance().findOne({ organization: orgId }).lean();
  if (!doc) return 0;

  const existingExpireRefs = new Set(
    doc.ledger.filter((e) => e.kind === 'expiration').map((e) => e.refId),
  );

  const expiredTopups = doc.ledger.filter(
    (e) =>
      e.kind === 'topup' &&
      e.expiresAt &&
      new Date(e.expiresAt) < now &&
      !existingExpireRefs.has(`expire-${e._id}`),
  );

  if (expiredTopups.length === 0) return 0;

  let applied = 0;
  for (const topup of expiredTopups) {
    const expireRefId = `expire-${topup._id}`;
    const entry = {
      kind: 'expiration',
      amount: -topup.amount,
      refId: expireRefId,
      at: now,
    };

    // Atomic: only push if this expiration refId is not already present.
    const result = await BillingExtraBalance().findOneAndUpdate(
      {
        organization: orgId,
        'ledger.refId': { $ne: expireRefId },
      },
      {
        $push: { ledger: entry },
        $inc: { cachedBalance: -topup.amount },
        $set: { cachedBalanceAt: now },
      },
    );
    if (result) applied += 1;
  }

  return applied;
};

/**
 * @function refundPartial
 * @description Atomically push a negative 'refund' ledger entry and decrement cachedBalance.
 *              Idempotent: if a ledger entry with the same refId already exists the update
 *              is a no-op and applied=false is returned.
 *              The balance may go negative when units were already consumed — this correctly
 *              reflects the economic debt (replenished on next creditPack).
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} stripeSessionId - Stripe session ID of the original purchase.
 * @param {number} refundUnits - Meter units to claw back (must be > 0).
 * @param {string} refId - Unique idempotency key for this refund (e.g. `refund-<sessionId>-<cents>`).
 * @returns {Promise<{doc: Object|null, applied: boolean}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const refundPartial = async (orgId, stripeSessionId, refundUnits, refId) => {
  if (!isValidOrgId(orgId)) return { doc: null, applied: false };
  if (!Number.isFinite(refundUnits) || refundUnits <= 0) throw new Error('invalid argument: refundUnits must be a positive finite number');
  if (typeof refId !== 'string' || refId.trim() === '') throw new Error('invalid argument: refId must be a non-empty string');
  const entry = {
    kind: 'refund',
    amount: -refundUnits,
    stripeSessionId,
    refId,
    at: new Date(),
  };

  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
      'ledger.refId': { $ne: refId },
    },
    {
      $push: { ledger: entry },
      $inc: { cachedBalance: -refundUnits },
      $set: { cachedBalanceAt: new Date() },
    },
    { returnDocument: 'after' },
  );

  if (doc) return { doc, applied: true };
  return { doc: null, applied: false };
};

/**
 * @function getBalance
 * @description Return the current cachedBalance for an organization.
 *              Cheap read — no ledger scan.
 * @param {string} orgId - The organization ObjectId (string).
 * @returns {Promise<number>} The cached balance, or 0 if no document exists.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const getBalance = async (orgId) => {
  if (!isValidOrgId(orgId)) return 0;
  const doc = await BillingExtraBalance().findOne({ organization: orgId }, { cachedBalance: 1 }).lean();
  return doc ? doc.cachedBalance : 0;
};

/**
 * @function findOrgsWithExpiringTopups
 * @description Return the distinct organizationIds that have at least one topup ledger entry
 *              with `expiresAt < now` for which no matching expiration entry (`kind: 'expiration'`
 *              with `refId: 'expire-<entryId>'`) has been recorded yet.
 *              Used by the billing.extrasExpiration cron to build the sweep target list.
 * @param {Date} now - Cutoff timestamp. Topups with expiresAt strictly before this are candidates.
 * @returns {Promise<string[]>} Array of distinct organizationId strings.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findOrgsWithExpiringTopups = async (now) => {
  if (!(now instanceof Date)) throw new TypeError('now must be a Date instance');
  // Pull only the ledger field (projection) to keep the payload small.
  // Note: the MongoDB pre-filter `ledger.expiresAt: { $lt: now }` is a coarse pre-filter —
  // some returned docs may have no unhandled expirations (already recorded expiration entries);
  // the in-memory loop below performs the precise check. This is intentional for simplicity.
  const docs = await BillingExtraBalance()
    .find(
      {
        'ledger.kind': 'topup',
        'ledger.expiresAt': { $lt: now },
      },
      { organization: 1, ledger: 1 },
    )
    .lean();

  const orgIds = [];
  for (const doc of docs) {
    const existingExpireRefs = new Set(
      (doc.ledger ?? []).filter((e) => e.kind === 'expiration').map((e) => e.refId),
    );
    const hasUnhandled = (doc.ledger ?? []).some(
      (e) =>
        e.kind === 'topup' &&
        e.expiresAt &&
        new Date(e.expiresAt) < now &&
        !existingExpireRefs.has(`expire-${e._id}`),
    );
    if (hasUnhandled) orgIds.push(String(doc.organization));
  }

  return orgIds;
};

export default {
  getOrCreate,
  creditPack,
  debit,
  addExpirationEntries,
  refundPartial,
  getBalance,
  findOrgsWithExpiringTopups,
};
