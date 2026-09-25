/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, afterEach, test, expect, jest } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for the credit-balance alert (#4117).
 *
 * On a one-shot signup-grant plan (meterQuota=0), incrementMeter's extras debit is
 * checked against the debit's own pre/post balance for a configured percent-of-grant
 * crossing (stateless — no alertedAtN dedup field). Validates against the real
 * BillingExtraBalance doc + the real billingEvents emitter (spied, not mocked).
 */
describe('BillingUsage credit-balance alert integration tests:', () => {
  let BillingUsage;
  let BillingExtraBalance;
  let Subscription;
  let BillingUsageService;
  let billingEvents;
  let originalMeterMode;
  let originalPlanDefinitions;

  beforeAll(async () => {
    originalMeterMode = config.billing.meterMode;
    originalPlanDefinitions = config.billing.planDefinitions;
    config.billing.meterMode = true;
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingUsage = mongoose.model('BillingUsage');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    Subscription = mongoose.model('Subscription');

    await Subscription.syncIndexes();

    BillingUsageService = (await import('../services/billing.usage.service.js')).default;
    billingEvents = (await import('../lib/events.js')).default;
  });

  beforeEach(async () => {
    await Promise.all([
      BillingUsage.deleteMany({}),
      BillingExtraBalance.deleteMany({}),
      Subscription.deleteMany({}),
    ]);
    config.billing.planDefinitions = [
      { planId: 'free', meterQuota: 0, signupGrant: 500, oneShot: true, ratios: { scrap: 1 } },
    ];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    config.billing.meterMode = originalMeterMode;
    config.billing.planDefinitions = originalPlanDefinitions;
    await mongooseService.disconnect();
  });

  test('extras debit crossing the 80% signup-grant level emits balance_threshold_crossed once; a later debit that stays above zero emits nothing new', async () => {
    const organizationId = new mongoose.Types.ObjectId();

    await Subscription.create({ organization: organizationId, plan: 'free', status: 'active' });

    // Seed the org's extras balance at the full signup grant (500), as if freshly credited.
    await BillingExtraBalance.create({
      organization: organizationId,
      ledger: [{ kind: 'topup', amount: 500, stripeSessionId: 'cs_signup_grant_seed' }],
      cachedBalance: 500,
    });

    const emitSpy = jest.spyOn(billingEvents, 'emit');
    const crossedEmits = () =>
      emitSpy.mock.calls.filter(([name]) => name === 'billing.extras.balance_threshold_crossed');

    // First debit: 401 units on a meterQuota=0 plan → every unit goes to extras.
    // pre=500 (post + extrasConsumed), post=99 → crosses the 80% level (500 * 20 / 100 = 100):
    // pre(500) > 100 && post(99) <= 100.
    await BillingUsageService.incrementMeter(
      organizationId.toString(),
      401,
      { scrap: 401 },
      'step-credit-alert-1',
    );

    expect(crossedEmits()).toHaveLength(1);
    expect(crossedEmits()[0][1]).toMatchObject({
      organizationId: organizationId.toString(),
      threshold: 80,
      remaining: 99,
      planId: 'free',
    });

    const balanceAfterFirst = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balanceAfterFirst.cachedBalance).toBe(99);

    // Second debit: 50 more units → extrasConsumed=50. pre=99, post=49 — stays above zero.
    // pre(99) is already at/below the 80% level (100), so no NEW crossing is emitted, and the
    // 100% level (0) is not reached either.
    await BillingUsageService.incrementMeter(
      organizationId.toString(),
      50,
      { scrap: 50 },
      'step-credit-alert-2',
    );

    expect(crossedEmits()).toHaveLength(1);

    const balanceAfterSecond = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balanceAfterSecond.cachedBalance).toBe(49);
  });
});
