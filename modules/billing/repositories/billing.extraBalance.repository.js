/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import AppError from '../../../lib/helpers/AppError.js';

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
 *              2-step pattern (aligned with debit):
 *                Step 1 — ensure doc exists (atomic getOrCreate, no-op on replay).
 *                Step 2 — idempotency-guarded credit (no upsert, returns null on replay).
 *              Eliminates E11000 duplicate-key risk on direct replay outside withIdempotency.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to credit (must be > 0).
 * @param {string} stripeSessionId - Stripe checkout session ID (idempotency key).
 * @param {Date|null} [expiresAt=null] - Optional expiry date for the topup entry.
 * @returns {Promise<{doc: Object|null, applied: boolean, reason?: string}>} Updated doc and whether the credit was applied.
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

  // Step 1: ensure the document exists (atomic getOrCreate, no-op if already present).
  await getOrCreate(orgId);

  // Step 2: idempotency-guarded credit (no upsert — doc is guaranteed to exist after step 1).
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
    { returnDocument: 'after' },
  );

  if (doc) return { doc, applied: true };
  return { doc: null, applied: false, reason: 'duplicate_session' };
};

/**
 * @function debit
 * @description Atomically debit meter units from the extra balance.
 *              Guard: no existing ledger entry with refId (idempotency).
 *              Negative cachedBalance is allowed — the requireQuota middleware gates entry
 *              at scrap-start (remaining > 0); mid-operation overages may push the balance
 *              below zero, which correctly reflects economic debt (same pattern as refundPartial).
 *              Upserts the document when none exists yet (org paying without prior pack purchase)
 *              so overage debt is never silently lost on the next weekly meter reset.
 *              Returns applied=false only when refId is already present (replay).
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to debit (must be > 0).
 * @param {string} refId - Unique reference for this debit (idempotency key).
 * @returns {Promise<{doc: Object|null, applied: boolean, reason?: string}>} Updated doc and whether debit was applied.
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

  // Step 1: ensure the document exists (atomic getOrCreate, no-op if already present).
  // Guard: if no doc exists yet, validate that the organization exists before creating a
  // dangling ExtraBalance doc for a ghost org (Opus H4). Accepts proof via either the
  // Organization collection OR the Subscription collection — a valid Subscription is
  // sufficient evidence that the org is real (provisioning sometimes writes Subscription
  // before the full Organization doc, e.g. in CLI tools or integration tests).
  const existing = await BillingExtraBalance().exists({ organization: orgId });
  if (!existing) {
    const { default: OrganizationRepository } = await import('../../organizations/repositories/organizations.repository.js');
    const orgExists = await OrganizationRepository.exists({ _id: orgId });
    if (!orgExists) {
      const Subscription = mongoose.model('Subscription');
      const subExists = await Subscription.exists({ organization: orgId });
      if (!subExists) {
        throw Object.assign(
          new AppError(`Organization not found: ${orgId}`, { status: 404, code: 'ORGANIZATION_NOT_FOUND' }),
          { organizationId: orgId },
        );
      }
    }
  }

  await BillingExtraBalance().findOneAndUpdate(
    { organization: orgId },
    { $setOnInsert: { organization: orgId, ledger: [], cachedBalance: 0, cachedBalanceAt: new Date() } },
    { upsert: true },
  );

  // Step 2: apply the debit with idempotency guard.
  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
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
  return { doc: null, applied: false, reason: 'duplicate_step' };
};

/**
 * @function creditCompensation
 * @description Atomically push a positive 'adjustment' ledger entry for dispute/ops compensation.
 *              Idempotent: if a ledger entry with the same refId already exists the update
 *              is a no-op and applied=false is returned.
 *              Uses a 2-step pattern aligned with creditPack:
 *                Step 1 — ensure doc exists (getOrCreate, no-op on replay).
 *                Step 2 — idempotency-guarded credit push.
 *              Intended use: admin dispute reinstatement, manual ops corrections.
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to credit (must be > 0).
 * @param {string} refId - Unique idempotency key (e.g. `dispute-credit-<refundRequestId>`).
 * @param {string} [memo] - Optional human-readable memo stored in the ledger entry.
 * @returns {Promise<{doc: Object|null, applied: boolean, reason?: string}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const creditCompensation = async (orgId, amount, refId, memo = '') => {
  if (!isValidOrgId(orgId)) return { doc: null, applied: false };
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid argument: amount must be a positive finite number');
  if (typeof refId !== 'string' || refId.trim() === '') throw new Error('invalid argument: refId must be a non-empty string');

  const entry = {
    kind: 'adjustment',
    amount,
    refId,
    at: new Date(),
    ...(memo ? { memo } : {}),
  };

  // Step 1: ensure the document exists (atomic getOrCreate, no-op if already present).
  await getOrCreate(orgId);

  // Step 2: idempotency-guarded credit (no upsert — doc is guaranteed to exist after step 1).
  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
      'ledger.refId': { $ne: refId },
    },
    {
      $push: { ledger: entry },
      $inc: { cachedBalance: amount },
      $set: { cachedBalanceAt: new Date() },
    },
    { returnDocument: 'after' },
  );

  if (doc) return { doc, applied: true };
  return { doc: null, applied: false, reason: 'duplicate_refId' };
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
 * @function listLedgerPage
 * @description Return a paginated slice of the ledger array for an organization using
 *              MongoDB aggregation `$slice` — only the requested page is transferred over the
 *              wire, avoiding full-document fetches for large ledgers (1000+ entries).
 *
 *              Entries are sorted descending by `at` (newest first) at the aggregation layer.
 *              The aggregation pipeline is:
 *                1. $match   — find the org's document
 *                2. $project — sort + slice the ledger, plus cachedBalance and _id=0
 *
 *              Returns null when no document exists for the org yet (balance = 0).
 *
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} skip - Number of entries to skip (0-based).
 * @param {number} limit - Maximum number of entries to return.
 * @returns {Promise<{ledgerPage: Object[], total: number, cachedBalance: number}|null>}
 *   null when the org has no ExtraBalance document.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const listLedgerPage = async (orgId, skip, limit) => {
  if (!isValidOrgId(orgId)) return null;
  if (!Number.isFinite(skip) || skip < 0) throw new TypeError('skip must be a non-negative number');
  if (!Number.isFinite(limit) || limit <= 0) throw new TypeError('limit must be a positive number');

  const results = await BillingExtraBalance().aggregate([
    { $match: { organization: new mongoose.Types.ObjectId(orgId) } },
    {
      $project: {
        _id: 0,
        cachedBalance: 1,
        total: { $size: { $ifNull: ['$ledger', []] } },
        // Sort descending by `at` then slice the requested page.
        // $ifNull guards against missing/null ledger field on legacy docs.
        ledgerPage: {
          $slice: [
            {
              $sortArray: {
                input: { $ifNull: ['$ledger', []] },
                sortBy: { at: -1 },
              },
            },
            skip,
            limit,
          ],
        },
      },
    },
  ]).exec();

  if (!results || results.length === 0) return null;
  return results[0];
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

/**
 * Fetch the full ledger array for an org.
 * Returns null when no document exists yet (org has never had extras).
 * @param {string} orgId - Organization ObjectId (string).
 * @returns {Promise<Object[]|null>} Ledger entries array or null.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findLedgerByOrg = async (orgId) => {
  if (!isValidOrgId(orgId)) return null;
  const doc = await BillingExtraBalance().findOne(
    { organization: orgId },
    { ledger: 1 },
  ).lean();
  return doc?.ledger ?? null;
};

/**
 * Sum absolute debit entries within a time window using a server-side aggregation.
 * Avoids loading the full ledger into memory — O(1) payload regardless of ledger size.
 *
 * Used by the billing reconcile service to compute actualExtrasDebits for the current week.
 *
 * @param {string} orgId - Organization ObjectId (string).
 * @param {Date} windowStart - Inclusive lower bound (entries with at >= windowStart).
 * @param {Date} windowEnd - Exclusive upper bound (entries with at < windowEnd).
 * @returns {Promise<number>} Sum of absolute debit amounts in the window, or 0.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const sumDebitsByWindow = async (orgId, windowStart, windowEnd) => {
  if (!isValidOrgId(orgId)) return 0;

  const [result] = await BillingExtraBalance().aggregate([
    { $match: { organization: new mongoose.Types.ObjectId(orgId) } },
    { $unwind: '$ledger' },
    {
      $match: {
        'ledger.kind': 'debit',
        'ledger.at': { $gte: windowStart, $lt: windowEnd },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $abs: '$ledger.amount' } },
      },
    },
  ]);

  return result?.total ?? 0;
};

export default {
  getOrCreate,
  creditPack,
  creditCompensation,
  debit,
  addExpirationEntries,
  refundPartial,
  getBalance,
  listLedgerPage,
  findOrgsWithExpiringTopups,
  findLedgerByOrg,
  sumDebitsByWindow,
};
