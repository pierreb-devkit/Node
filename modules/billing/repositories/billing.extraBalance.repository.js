/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import AppError from '../../../lib/helpers/AppError.js';
import BillingExtraBalanceSchema from '../models/billing.extraBalance.schema.js';
import { computeExpiryRemovals } from '../lib/billing.packExpiry.js';

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
 * @function creditGrant
 * @description Atomically credit extra meter units for a non-Stripe grant (e.g. signup free
 *              tier, referral grant). Idempotent: if a ledger entry with the same refId
 *              already exists, the update is a no-op and applied=false is returned.
 *              2-step pattern aligned with creditPack:
 *                Step 1 — ensure doc exists (atomic getOrCreate, no-op on replay).
 *                Step 2 — idempotency-guarded credit (no upsert).
 *              Idempotency key: `options.refId` when supplied (#3842 referral grants —
 *              several grants per org, one per invitation, e.g.
 *              `referral:<invitationId>:referrer`), otherwise the synthetic per-org key
 *              `<source>-<orgId>` (signup grant — one per org).
 *              `options.expiresAt` mirrors the creditPack expiry mechanism: the entry is
 *              swept by crons/billing.extrasExpiration.js once past its expiry.
 *              No stripeSessionId required.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {number} amount - Meter units to credit (must be > 0).
 * @param {string} source - Grant source tag (e.g. 'signup_grant', 'referral').
 * @param {Object} [options]
 * @param {string} [options.refId] - Explicit idempotency key (defaults to `<source>-<orgId>`).
 * @param {Date|null} [options.expiresAt=null] - Optional expiry date for the grant entry.
 * @returns {Promise<{doc: Object|null, applied: boolean, reason?: string}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const creditGrant = async (orgId, amount, source, { refId = null, expiresAt = null } = {}) => {
  if (!isValidOrgId(orgId)) return { doc: null, applied: false };
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid argument: amount must be a positive finite number');
  if (typeof source !== 'string' || source.trim() === '') throw new Error('invalid argument: source must be a non-empty string');
  if (refId !== null && (typeof refId !== 'string' || refId.trim() === '')) throw new Error('invalid argument: refId must be a non-empty string when provided');
  // Validate source against the enum before writing — findOneAndUpdate does not run validators.
  BillingExtraBalanceSchema.ExtraBalanceCreditGrant.parse({
    orgId,
    amount,
    source: source.trim(),
    ...(refId ? { refId: refId.trim() } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });

  const idempotencyKey = refId ? refId.trim() : `${source.trim()}-${orgId}`;
  const entry = {
    kind: 'topup',
    amount,
    source: source.trim(),
    refId: idempotencyKey,
    at: new Date(),
    ...(expiresAt ? { expiresAt } : {}),
  };

  // Step 1: ensure the document exists (atomic getOrCreate, no-op if already present).
  await getOrCreate(orgId);

  // Step 2: idempotency-guarded credit (no upsert — doc is guaranteed to exist after step 1).
  const doc = await BillingExtraBalance().findOneAndUpdate(
    {
      organization: orgId,
      'ledger.refId': { $ne: idempotencyKey },
    },
    {
      $push: { ledger: entry },
      $inc: { cachedBalance: amount },
      $set: { cachedBalanceAt: new Date() },
    },
    { returnDocument: 'after' },
  );

  if (doc) return { doc, applied: true };
  return { doc: null, applied: false, reason: 'duplicate_grant' };
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
 * Bound on the read → guarded-write retries of addExpirationEntries. Each retry means a
 * concurrent write landed between the read and the write; past this bound the sweep
 * throws so the cron logs the org and retries it on its next run.
 */
const EXPIRY_MAX_ATTEMPTS = 5;

/**
 * @function addExpirationEntries
 * @description Sweep topup entries that have expired and push one expiration ledger entry
 *              per pack, removing only that pack's OWN unspent units at its `expiresAt`
 *              (see lib/billing.packExpiry.js: ledger replay, earliest-expiry-first
 *              attribution). A pack fully spent or refunded at expiry gets a zero-amount
 *              expiration marker: it removes nothing but records the pack as handled, so a
 *              later sweep never expires it against units bought afterwards.
 *              Idempotent: each topup produces at most one expiration entry
 *              (refId 'expire-<topupId>'). Existing legacy full-amount entries are left as is.
 *              Concurrency: the removals are computed from a snapshot of the ledger, then
 *              pushed with ONE findOneAndUpdate guarded by the snapshot's ledger length
 *              (`$size`) and by the absence of every refId being written. The ledger is
 *              append-only, so an unchanged length means an unchanged ledger: a concurrent
 *              debit, topup, refund or sweep makes the guard miss, and the sweep re-reads and
 *              recomputes (bounded by EXPIRY_MAX_ATTEMPTS, then throws). This keeps the
 *              removal exact without a transaction or a new persisted field.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {Date} now - The current timestamp used as the expiry cutoff.
 * @returns {Promise<number>} Number of expiration entries added (zero markers included).
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const addExpirationEntries = async (orgId, now) => {
  if (!isValidOrgId(orgId)) return 0;

  for (let attempt = 0; attempt < EXPIRY_MAX_ATTEMPTS; attempt += 1) {
    const doc = await BillingExtraBalance().findOne({ organization: orgId }, { ledger: 1 }).lean();
    if (!doc) return 0;
    const ledger = doc.ledger ?? [];

    const removals = computeExpiryRemovals(ledger, now);
    if (removals.length === 0) return 0;

    const entries = removals.map(({ topupId, amount }) => ({
      kind: 'expiration',
      amount: amount > 0 ? -amount : 0,
      refId: `expire-${topupId}`,
      at: now,
    }));
    const removed = removals.reduce((sum, r) => sum + r.amount, 0);

    const result = await BillingExtraBalance().findOneAndUpdate(
      {
        organization: orgId,
        ledger: { $size: ledger.length },
        'ledger.refId': { $nin: entries.map((e) => e.refId) },
      },
      {
        $push: { ledger: { $each: entries } },
        $inc: { cachedBalance: -removed },
        $set: { cachedBalanceAt: now },
      },
    );
    if (result) return entries.length;
  }

  throw new Error(`addExpirationEntries: ledger kept changing for org ${orgId} after ${EXPIRY_MAX_ATTEMPTS} attempts`);
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
 * @function getSettlementBasis
 * @description Read, in ONE query, the inputs of the weekly overflow-debt settlement:
 *              the cached balance and the UNPAID non-settleable debt — refund and
 *              expiration debt — returned as a positive number. A single read keeps both
 *              values consistent with each other against a concurrent debit.
 *              Non-settleable debt is rebuilt by replaying the ledger in ARRAY order (the
 *              true commit order: every writer appends with an atomic `$push`) with a
 *              running balance: a 'refund' or 'expiration' entry adds only the part that
 *              pushes the running balance below zero (an amount absorbed by a positive
 *              balance is no debt). Refund debt and pack-expiry shortfall are never
 *              settled from quota; only a new Stripe pack 'topup' (stripeSessionId set —
 *              creditPack) repays them, floored at 0. Grants, 'adjustment' entries
 *              (including `settle:<weekKey>` settlements) and debits never repay them.
 *              The expiry sweep removes only a pack's own unspent units, so a new expiration
 *              entry goes below zero only for usage recorded between the pack's expiresAt
 *              and the sweep; that part, like legacy full-amount entries, stays
 *              non-settleable. Zero-amount expiration markers are neutral. The result is capped at max(0, -cachedBalance).
 * @param {string} orgId - The organization ObjectId (string).
 * @returns {Promise<{cachedBalance: number, nonSettleableDebt: number}>} Zeros when no document exists.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const getSettlementBasis = async (orgId) => {
  if (!isValidOrgId(orgId)) return { cachedBalance: 0, nonSettleableDebt: 0 };
  const doc = await BillingExtraBalance().findOne(
    { organization: orgId },
    {
      cachedBalance: 1,
      'ledger.kind': 1,
      'ledger.amount': 1,
      'ledger.stripeSessionId': 1,
    },
  ).lean();
  if (!doc) return { cachedBalance: 0, nonSettleableDebt: 0 };
  let running = 0;
  let nonSettleableDebt = 0;
  for (const e of doc.ledger ?? []) {
    const amount = e.amount ?? 0;
    running += amount;
    if ((e.kind === 'refund' || e.kind === 'expiration') && amount < 0) {
      nonSettleableDebt += Math.min(-amount, Math.max(0, -running));
    } else if (e.kind === 'topup' && amount > 0 && typeof e.stripeSessionId === 'string' && e.stripeSessionId.length > 0) {
      nonSettleableDebt = Math.max(0, nonSettleableDebt - amount);
    }
  }
  const cachedBalance = doc.cachedBalance ?? 0;
  return { cachedBalance, nonSettleableDebt: Math.min(nonSettleableDebt, Math.max(0, -cachedBalance)) };
};

/**
 * @function findLedgerEntryByRefId
 * @description Return the single ledger entry carrying `refId` for an organization, or null.
 *              Positional projection — only the matching entry crosses the wire.
 *              Used by the weekly reset to read the `settle:<weekKey>` adjustment actually stored.
 * @param {string} orgId - The organization ObjectId (string).
 * @param {string} refId - The ledger entry idempotency key.
 * @returns {Promise<Object|null>} The ledger entry, or null when absent.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findLedgerEntryByRefId = async (orgId, refId) => {
  if (!isValidOrgId(orgId) || typeof refId !== 'string' || refId === '') return null;
  const doc = await BillingExtraBalance().findOne(
    { organization: orgId, 'ledger.refId': refId },
    { 'ledger.$': 1 },
  ).lean();
  return doc?.ledger?.[0] ?? null;
};

/**
 * @function listLedgerPage
 * @description Return a paginated slice of the ledger array for an organization using
 *              MongoDB aggregation — only the requested page is transferred over the
 *              wire, avoiding full-document fetches for large ledgers (1000+ entries).
 *
 *              Entries are sorted descending by `at` (newest first) at the aggregation layer.
 *              The aggregation pipeline is:
 *                1. $match    — find the org's document
 *                2. $project  — normalise ledger with $ifNull, drop zero expiration markers
 *                3. $project  — capture total + cachedBalance
 *                4. $unwind   — explode ledger entries into individual documents
 *                5. $sort     — sort by ledger.at descending (compatible with MongoDB ≥4.4)
 *                6. $group    — reassemble into a single document, collecting sorted entries
 *                7. $project  — apply skip+limit slice and reshape to final shape
 *
 *              Note: $sortArray (MongoDB ≥5.2) is intentionally avoided so the repository
 *              works on MongoDB 5.0.x (mongodb-memory-server default in CI).
 *              The $unwind + $sort + $group pattern is equivalent and fully portable.
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
    // Normalise a missing ledger to [] and drop zero-amount expiration markers: they only
    // record that a fully spent pack's expiry was handled (addExpirationEntries), carry no
    // balance change, and would read as a '+0' credit in a customer-facing ledger.
    {
      $project: {
        _id: 1,
        cachedBalance: 1,
        ledger: {
          $filter: {
            input: { $ifNull: ['$ledger', []] },
            cond: { $not: [{ $and: [{ $eq: ['$$this.kind', 'expiration'] }, { $eq: ['$$this.amount', 0] }] }] },
          },
        },
      },
    },
    // Capture total count and cachedBalance before unwinding.
    {
      $project: {
        _id: 1,
        cachedBalance: 1,
        total: { $size: '$ledger' },
        ledger: 1,
      },
    },
    // Preserve docs with an empty ledger (preserveNullAndEmptyArrays keeps the root doc).
    { $unwind: { path: '$ledger', preserveNullAndEmptyArrays: true } },
    // Sort entries descending by `at` (newest first). Compatible with MongoDB ≥4.4.
    { $sort: { 'ledger.at': -1 } },
    // Reassemble the sorted entries back into a single document per org.
    {
      $group: {
        _id: '$_id',
        cachedBalance: { $first: '$cachedBalance' },
        total: { $first: '$total' },
        // $push preserves the $sort order guaranteed by the preceding $sort stage.
        sortedLedger: { $push: '$ledger' },
      },
    },
    // Slice the sorted array to the requested page and drop internal fields.
    // $filter removes the null sentinel emitted by $unwind when ledger was empty
    // (preserveNullAndEmptyArrays keeps the parent doc alive but pushes null into $group).
    {
      $project: {
        _id: 0,
        cachedBalance: 1,
        total: 1,
        ledgerPage: {
          $slice: [
            { $filter: { input: '$sortedLedger', cond: { $ne: ['$$this', null] } } },
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
 * @function findExistingRefIds
 * @description Return the subset of `refIds` that already exist as ledger entry refIds
 *              (any org). Used by the referral reconcile cron (#3842) to diff the
 *              expected grant keys (`referral:<invitationId>:referrer|referee`) against
 *              the ledger and back-fill only the misses.
 *              Server-side aggregation — the first $match uses the sparse
 *              `{ 'ledger.refId': 1, 'ledger.source': 1 }` index to narrow the doc set.
 * @param {string[]} refIds - Candidate idempotency keys to look up.
 * @returns {Promise<string[]>} The refIds already present in any ledger.
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js repository, not Qwik
const findExistingRefIds = async (refIds) => {
  if (!Array.isArray(refIds) || refIds.length === 0) return [];
  const rows = await BillingExtraBalance().aggregate([
    { $match: { 'ledger.refId': { $in: refIds } } },
    { $unwind: '$ledger' },
    { $match: { 'ledger.refId': { $in: refIds } } },
    { $group: { _id: '$ledger.refId' } },
  ]).exec();
  return rows.map((r) => String(r._id));
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
  creditGrant,
  creditCompensation,
  debit,
  addExpirationEntries,
  refundPartial,
  getBalance,
  getSettlementBasis,
  findLedgerEntryByRefId,
  listLedgerPage,
  findOrgsWithExpiringTopups,
  findExistingRefIds,
  findLedgerByOrg,
  sumDebitsByWindow,
};
