/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { jest, describe, beforeAll, beforeEach, afterEach, afterAll, test, expect } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { isoWeekKey } from '../lib/billing.isoWeek.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA = 100;

/**
 * Integration tests for the weekly overflow-debt settlement in resetWeek.
 *
 * Overflow debt (negative extras from usage past the quota) is repaid once per
 * week from the target week's REMAINING quota (quota − meterUsed at reset time):
 * extras are credited `settle` via an idempotent 'adjustment' entry, then the week
 * is charged that stored credit exactly once. What does not fit stays as debt.
 * Unpaid refund and expiration debt is never settled; quota-0 plans are untouched.
 */
describe('BillingResetService overflow debt settlement integration tests:', () => {
  let BillingUsage;
  let BillingExtraBalance;
  let Subscription;
  let BillingResetService;
  let BillingUsageService;
  let BillingUsageRepository;
  let BillingExtraBalanceRepository;
  let assertCanExecute;
  let originalMeterMode;
  let originalPlanDefinitions;
  let orgId;
  let now;

  /**
   * @param {number} n - Week offset from now.
   * @returns {Date} periodStart n weeks from now.
   */
  const week = (n) => new Date(now.getTime() + n * WEEK_MS);

  /**
   * Units the org can still consume in a week — assertCanExecute's `remaining`, floored at 0.
   * @param {number} n - Week offset from now.
   * @returns {Promise<{usable: number, meterUsed: number, balance: number, adjustments: Object[]}>}
   */
  const stateAt = async (n) => {
    const usage = await BillingUsage.findOne({ organizationId: orgId, weekKey: isoWeekKey(week(n)) }).lean();
    const extras = await BillingExtraBalance.findOne({ organization: orgId }).lean();
    const meterUsed = usage?.meterUsed ?? 0;
    const balance = extras?.cachedBalance ?? 0;
    return {
      usable: Math.max(0, Math.max(0, (usage?.meterQuota ?? 0) - meterUsed) + balance),
      meterUsed,
      balance,
      adjustments: (extras?.ledger ?? []).filter((e) => e.kind === 'adjustment'),
    };
  };

  /**
   * Seed an extras doc whose balance is the sum of the given ledger entries.
   * @param {Object[]} ledger - Ledger entries.
   * @returns {Promise<void>}
   */
  const seedExtras = async (ledger) => {
    const cachedBalance = ledger.reduce((sum, e) => sum + e.amount, 0);
    await BillingExtraBalance.create({ organization: orgId, ledger, cachedBalance });
  };

  beforeAll(async () => {
    originalMeterMode = config.billing.meterMode;
    originalPlanDefinitions = config.billing.planDefinitions;
    config.billing.meterMode = true;
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingUsage = mongoose.model('BillingUsage');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    Subscription = mongoose.model('Subscription');
    await BillingUsage.syncIndexes();

    BillingResetService = (await import('../services/billing.reset.service.js')).default;
    BillingUsageService = (await import('../services/billing.usage.service.js')).default;
    BillingUsageRepository = (await import('../repositories/billing.usage.repository.js')).default;
    BillingExtraBalanceRepository = (await import('../repositories/billing.extraBalance.repository.js')).default;
    ({ assertCanExecute } = await import('../services/billing.quota.service.js'));
  });

  beforeEach(async () => {
    await Promise.all([
      BillingUsage.deleteMany({}),
      BillingExtraBalance.deleteMany({}),
      Subscription.deleteMany({}),
    ]);
    config.billing.planDefinitions = [
      { planId: 'free', version: 'free-v1', meterQuota: 0, ratios: { default: 1 } },
      { planId: 'pro', version: 'pro-v1', meterQuota: QUOTA, ratios: { default: 1 } },
    ];
    orgId = new mongoose.Types.ObjectId().toString();
    now = new Date();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    config.billing.meterMode = originalMeterMode;
    config.billing.planDefinitions = originalPlanDefinitions;
    await mongooseService.disconnect();
  });

  test('fresh week, debt below quota → that week usable Q−D, the week after Q', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    // Real overflow: 130 units on a 100 quota → 30 units debited from extras.
    await BillingUsageService.incrementMeter(orgId, 130, { default: 130 }, 'run-overflow-1');
    expect((await stateAt(0)).balance).toBe(-30);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
    expect(w1.usable).toBe(QUOTA - 30);
    expect(w1.adjustments).toHaveLength(1);
    expect(w1.adjustments[0]).toEqual(expect.objectContaining({ amount: 30, refId: `settle:${isoWeekKey(week(1))}` }));

    await BillingResetService.resetWeek(orgId, week(2));
    const w2 = await stateAt(2);
    expect(w2.meterUsed).toBe(0);
    expect(w2.usable).toBe(QUOTA);
    expect(w2.adjustments).toHaveLength(1);
  });

  test('fresh week, debt at or above quota → one week at 0, then the remainder, then full quota', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -150, refId: 'run-big-overflow' }]);

    // Current week: settles a full quota, nothing usable.
    await BillingResetService.resetWeek(orgId, week(0));
    const w0 = await stateAt(0);
    expect(w0.meterUsed).toBe(QUOTA);
    expect(w0.balance).toBe(-50);
    expect(w0.usable).toBe(0);
    await expect(assertCanExecute({ orgId, resource: 'default', action: 'run' })).rejects.toMatchObject({ status: 402 });

    // Remainder repaid: 50 settled, 50 usable.
    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(50);
    expect(w1.balance).toBe(0);
    expect(w1.usable).toBe(QUOTA - 50);

    await BillingResetService.resetWeek(orgId, week(2));
    const w2 = await stateAt(2);
    expect(w2.meterUsed).toBe(0);
    expect(w2.usable).toBe(QUOTA);
    expect(w2.adjustments).toHaveLength(2);
  });

  test('refund debt is never settled', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([
      { kind: 'debit', amount: -40, refId: 'run-overflow-2' },
      { kind: 'refund', amount: -60, refId: 'refund-rf_1-x', stripeSessionId: 'cs_1' },
    ]);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(40);
    expect(w1.balance).toBe(-60);

    await BillingResetService.resetWeek(orgId, week(2));
    const w2 = await stateAt(2);
    expect(w2.meterUsed).toBe(0);
    expect(w2.balance).toBe(-60);
    expect(w2.adjustments).toHaveLength(1);
  });

  test('only refund debt → nothing settled', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'refund', amount: -60, refId: 'refund-rf_2-x', stripeSessionId: 'cs_2' }]);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(0);
    expect(w1.balance).toBe(-60);
    expect(w1.adjustments).toHaveLength(0);
  });

  test('resetWeek re-run for the same week → no double credit', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-3' }]);

    await BillingResetService.resetWeek(orgId, week(1));
    await BillingResetService.resetWeek(orgId, week(1));
    await Promise.all([
      BillingResetService.resetWeek(orgId, week(1)),
      BillingResetService.resetWeek(orgId, week(1)),
    ]);

    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
  });

  test('concurrent first resets of the same week → one insert, one credit', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-4' }]);

    await Promise.all(Array.from({ length: 5 }, () => BillingResetService.resetWeek(orgId, week(1))));

    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
  });

  test('refund absorbed by a positive balance → later overflow debt IS settled', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    const t = (n) => new Date(now.getTime() - (10 - n) * 60 * 1000);
    await seedExtras([
      { kind: 'topup', amount: 50, stripeSessionId: 'cs_pos', at: t(1) },
      { kind: 'refund', amount: -50, refId: 'refund-rf_pos-x', stripeSessionId: 'cs_pos', at: t(2) },
      { kind: 'debit', amount: -30, refId: 'run-overflow-pos', at: t(3) },
    ]);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
  });

  test('refund debt repaid by a pack → later overflow debt IS settled', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    const t = (n) => new Date(now.getTime() - (10 - n) * 60 * 1000);
    await seedExtras([
      { kind: 'refund', amount: -40, refId: 'refund-rf_neg-x', stripeSessionId: 'cs_neg', at: t(1) },
      { kind: 'topup', amount: 40, stripeSessionId: 'cs_repay', at: t(2) },
      { kind: 'debit', amount: -30, refId: 'run-overflow-neg', at: t(3) },
    ]);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
  });

  test('pack expiry after overflow use → expiration debt is never settled', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    const t = (n) => new Date(now.getTime() - (10 - n) * 60 * 1000);
    await seedExtras([
      { kind: 'topup', amount: 100, stripeSessionId: 'cs_exp', expiresAt: t(3), at: t(1) },
      { kind: 'debit', amount: -80, refId: 'run-overflow-exp', at: t(2) },
    ]);
    // The real sweep: expiry removes the FULL pack amount although 80 was consumed.
    await expect(BillingExtraBalanceRepository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    expect((await stateAt(0)).balance).toBe(-80);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(0);
    expect(w1.balance).toBe(-80);
    expect(w1.adjustments).toHaveLength(0);
  });

  test('concurrent resets → one credit and meterUsed == the stored credit', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -45, refId: 'run-overflow-5' }]);

    await Promise.all(Array.from({ length: 8 }, () => BillingResetService.resetWeek(orgId, week(1))));

    const w1 = await stateAt(1);
    expect(w1.adjustments).toHaveLength(1);
    expect(w1.meterUsed).toBe(w1.adjustments[0].amount);
    expect(w1.meterUsed).toBe(45);
    expect(w1.balance).toBe(0);
  });

  test('week doc pre-created by incrementMeter → settlement still applied once', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-6' }]);
    await BillingUsageRepository.incrementMeter(orgId, isoWeekKey(week(1)), 5, { default: 5 }, `${new mongoose.Types.ObjectId()}:initial`, {
      meterQuota: QUOTA,
      planVersion: 'pro-v1',
    });

    await BillingResetService.resetWeek(orgId, week(1));
    await BillingResetService.resetWeek(orgId, week(1));

    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(35);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
  });

  test('insert error → no credit; retry settles once', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-7' }]);
    jest.spyOn(BillingUsageRepository, 'upsertWeekSnapshot').mockRejectedValueOnce(new Error('write failed'));

    await expect(BillingResetService.resetWeek(orgId, week(1))).rejects.toThrow('write failed');
    const mid = await stateAt(1);
    expect(mid.balance).toBe(-30); // week doc is read before any credit
    expect(mid.adjustments).toHaveLength(0);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(30);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
  });

  test('charge error after the credit, then retry → stored credit charged, not recomputed', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-9' }]);
    jest.spyOn(BillingUsageRepository, 'applySettlementUsage').mockRejectedValueOnce(new Error('write failed'));

    await expect(BillingResetService.resetWeek(orgId, week(1))).rejects.toThrow('write failed');
    const mid = await stateAt(1);
    expect(mid.balance).toBe(0); // credit landed, week not charged yet
    expect(mid.meterUsed).toBe(0);

    // Usage between the two calls leaves only 20 of headroom: a recompute would settle 20.
    await BillingUsageRepository.incrementMeter(orgId, isoWeekKey(week(1)), 80, { default: 80 }, `${new mongoose.Types.ObjectId()}:initial`, {
      meterQuota: QUOTA,
      planVersion: 'pro-v1',
    });
    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(110);
    expect(w1.balance).toBe(0);
    expect(w1.adjustments).toHaveLength(1);
    expect(w1.adjustments[0].amount).toBe(30);
  });

  test('reset anchored now, week already partly used → settles only the remaining headroom', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -50, refId: 'run-overflow-10' }]);
    // Earlier in the same ISO week: 70 of 100 already used.
    await BillingUsageService.incrementMeter(orgId, 70, { default: 70 }, `${new mongoose.Types.ObjectId()}:initial`);

    await BillingResetService.resetWeek(orgId, now);
    const w0 = await stateAt(0);
    expect(w0.adjustments).toHaveLength(1);
    expect(w0.adjustments[0].amount).toBe(QUOTA - 70);
    expect(w0.meterUsed).toBe(QUOTA);
    expect(w0.balance).toBe(-(50 - (QUOTA - 70)));

    // The rest is repaid by the next reset.
    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(20);
    expect(w1.balance).toBe(0);
  });

  test('reset anchored now, quota already used up → no credit, debt unchanged', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -50, refId: 'run-overflow-11' }]);
    await BillingUsageService.incrementMeter(orgId, QUOTA, { default: QUOTA }, `${new mongoose.Types.ObjectId()}:initial`);

    await BillingResetService.resetWeek(orgId, now);
    const w0 = await stateAt(0);
    expect(w0.meterUsed).toBe(QUOTA);
    expect(w0.balance).toBe(-50);
    expect(w0.adjustments).toHaveLength(0);
  });

  test('past periodStart (renewal webhook) → clamped to the current week, live week kept, debt settled into it', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -50, refId: 'run-overflow-past' }]);
    // 10 units already used in the live week.
    await BillingUsageService.incrementMeter(orgId, 10, { default: 10 }, `${new mongoose.Types.ObjectId()}:initial`);

    await BillingResetService.resetWeek(orgId, week(-1));

    // Nothing written to last week.
    expect(await BillingUsage.findOne({ organizationId: orgId, weekKey: isoWeekKey(week(-1)) }).lean()).toBeNull();
    // The live week is the target: not archived, settle = min(headroom 90, debt 50) = 50.
    const live = await BillingUsage.findOne({ organizationId: orgId, weekKey: isoWeekKey(now) }).lean();
    expect(live.archivedAt ?? null).toBeNull();
    const w0 = await stateAt(0);
    expect(w0.meterUsed).toBe(60);
    expect(w0.balance).toBe(0);
    expect(w0.adjustments).toHaveLength(1);
    expect(w0.adjustments[0]).toEqual(expect.objectContaining({ amount: 50, refId: `settle:${isoWeekKey(now)}` }));
  });

  test('credit failure → meterUsed 0 and debt unchanged', async () => {
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -30, refId: 'run-overflow-8' }]);
    jest.spyOn(BillingExtraBalanceRepository, 'creditCompensation').mockRejectedValueOnce(new Error('db down'));

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(0);
    expect(w1.balance).toBe(-30);
    expect(w1.adjustments).toHaveLength(0);
  });

  test('quota-0 plan → debt untouched', async () => {
    await Subscription.create({ organization: orgId, plan: 'free', status: 'active' });
    await seedExtras([{ kind: 'debit', amount: -50, refId: 'run-free-1' }]);

    await BillingResetService.resetWeek(orgId, week(1));
    const w1 = await stateAt(1);
    expect(w1.meterUsed).toBe(0);
    expect(w1.balance).toBe(-50);
    expect(w1.adjustments).toHaveLength(0);
  });
});
