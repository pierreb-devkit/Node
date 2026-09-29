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
 * org — double-crediting the same logical grant. Fixed by serializing the cross-org
 * check + write behind a database-enforced lock (lib/services/distributedLock.js) keyed
 * per idempotencyKey. These tests run against REAL MongoDB — the lock's unique-`_id`
 * claim is the property under test, which a mocked model cannot demonstrate.
 */
describe('BillingExtraBalanceRepository.creditGrant — cross-org race closure integration tests:', () => {
  let BillingExtraBalance;
  let BillingExtraBalanceRepository;
  let CronLock;

  const orgA = new mongoose.Types.ObjectId().toString();
  const orgB = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    BillingExtraBalanceRepository = (await import('../repositories/billing.extraBalance.repository.js')).default;
    ({ CronLock } = await import('../../../lib/services/distributedLock.js'));
  });

  beforeEach(async () => {
    await Promise.all([
      BillingExtraBalance.deleteMany({ organization: { $in: [orgA, orgB] } }),
      CronLock.deleteMany({ _id: /^billing\.creditGrant\./ }),
    ]);
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('concurrent creditGrant calls sharing one refId across TWO orgs → exactly ONE applied:true, ONE ledger entry total', async () => {
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
  }, 15000);

  test('a losing call releases the lock — a later replay for the SAME org+key still resolves idempotently', async () => {
    const sharedKey = `referral:${new mongoose.Types.ObjectId()}:referrer`;

    const [first] = await Promise.all([
      BillingExtraBalanceRepository.creditGrant(orgA, 1000, 'referral', { refId: sharedKey }),
      BillingExtraBalanceRepository.creditGrant(orgB, 1000, 'referral', { refId: sharedKey }),
    ]);
    const winnerOrg = first.applied ? orgA : orgB;

    // Sequential replay against the org that actually won — must stay a no-op (lock is
    // released after each call; this is the durable Step 0/2 dedup doing its job, not
    // the lock still being held).
    const replay = await BillingExtraBalanceRepository.creditGrant(winnerOrg, 1000, 'referral', { refId: sharedKey });
    expect(replay).toMatchObject({ applied: false, reason: 'duplicate_grant' });
  }, 15000);
});
