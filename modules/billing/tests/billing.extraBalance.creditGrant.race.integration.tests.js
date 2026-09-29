/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for creditGrant cross-organization idempotency-key race closure (#4155).
 *
 * A cross-org check-then-write is not atomic by itself: two concurrent creditGrant calls
 * sharing the same idempotencyKey but targeting DIFFERENT orgs (e.g. the in-process
 * referral listener racing the reconcile cron backfill for the same invitation) could
 * both observe "not yet granted" before either writes, and both would credit their own
 * org — double-crediting the same logical grant. A TTL/lease-based lock does not close
 * this either — it only narrows the window to "the write took longer than the lease".
 * Fixed with a genuinely durable claim (BillingGrantClaimRepository.tryClaim): a brand-new
 * collection, unique index on `key`, no TTL, nothing to release. These tests run against
 * REAL MongoDB — the unique-index claim is the property under test, which a mocked model
 * cannot demonstrate.
 */
describe('BillingExtraBalanceRepository.creditGrant — cross-org race closure integration tests:', () => {
  let BillingExtraBalance;
  let BillingGrantClaim;
  let BillingExtraBalanceRepository;

  const orgA = new mongoose.Types.ObjectId().toString();
  const orgB = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    BillingGrantClaim = mongoose.model('BillingGrantClaim');
    // The unique index on `key` is what makes the claim atomic — build it before the first
    // concurrent test runs, otherwise the first run can race the (async) index build.
    await BillingGrantClaim.syncIndexes();
    BillingExtraBalanceRepository = (await import('../repositories/billing.extraBalance.repository.js')).default;
  });

  beforeEach(async () => {
    await Promise.all([
      BillingExtraBalance.deleteMany({ organization: { $in: [orgA, orgB] } }),
      BillingGrantClaim.deleteMany({ organization: { $in: [orgA, orgB] } }),
    ]);
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('concurrent creditGrant calls sharing one refId across TWO orgs → exactly ONE applied:true, ONE ledger entry total, ONE claim', async () => {
    const sharedKey = `referral:${new mongoose.Types.ObjectId()}:referrer`;

    const [first, second] = await Promise.all([
      BillingExtraBalanceRepository.creditGrant(orgA, 1000, 'referral', { refId: sharedKey }),
      BillingExtraBalanceRepository.creditGrant(orgB, 1000, 'referral', { refId: sharedKey }),
    ]);

    // Exactly one org wins the grant; the loser surfaces the idempotent no-op — never both.
    const applied = [first, second].filter((r) => r.applied === true);
    expect(applied).toHaveLength(1);
    const duplicate = [first, second].filter((r) => r.applied === false);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].reason).toBe('duplicate_grant');

    // The key was credited to exactly ONE of the two orgs, never both.
    const [docA, docB] = await Promise.all([
      BillingExtraBalance.findOne({ organization: orgA }).lean(),
      BillingExtraBalance.findOne({ organization: orgB }).lean(),
    ]);
    const entriesA = (docA?.ledger ?? []).filter((e) => e.refId === sharedKey);
    const entriesB = (docB?.ledger ?? []).filter((e) => e.refId === sharedKey);
    expect(entriesA.length + entriesB.length).toBe(1);

    // Exactly one claim document for the key, owned by whichever org actually won.
    const claims = await BillingGrantClaim.find({ key: sharedKey }).lean();
    expect(claims).toHaveLength(1);
    const winnerOrg = entriesA.length === 1 ? orgA : orgB;
    expect(String(claims[0].organization)).toBe(winnerOrg);
  }, 15000);

  test('a losing call leaves the claim permanently owned by the winner — a later replay for the SAME org+key still resolves idempotently', async () => {
    const sharedKey = `referral:${new mongoose.Types.ObjectId()}:referrer`;

    const [first] = await Promise.all([
      BillingExtraBalanceRepository.creditGrant(orgA, 1000, 'referral', { refId: sharedKey }),
      BillingExtraBalanceRepository.creditGrant(orgB, 1000, 'referral', { refId: sharedKey }),
    ]);
    const winnerOrg = first.applied ? orgA : orgB;

    // Sequential replay against the org that actually won — must stay a no-op. No lock to
    // release: the claim is permanent, the per-org ledger guard is the durable dedup.
    const replay = await BillingExtraBalanceRepository.creditGrant(winnerOrg, 1000, 'referral', { refId: sharedKey });
    expect(replay).toMatchObject({ applied: false, reason: 'duplicate_grant' });

    // A retry from the LOSING org must still be rejected — the claim does not expire.
    const loserOrg = winnerOrg === orgA ? orgB : orgA;
    const loserRetry = await BillingExtraBalanceRepository.creditGrant(loserOrg, 1000, 'referral', { refId: sharedKey });
    expect(loserRetry).toMatchObject({ applied: false, reason: 'duplicate_grant' });
  }, 15000);
});
