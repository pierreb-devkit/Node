/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, afterEach, test, expect, jest } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { isoWeekKey } from '../lib/billing.isoWeek.js';

/**
 * Integration tests for meter lifecycle hardening.
 *
 * BillingPlan collection has been removed — plan definitions come from
 * config.billing.planDefinitions. Tests that previously relied on
 * BillingPlan.create() now seed planDefinitions directly on config.
 *
 * BillingMeterOutbox has been removed — extras debit is now inline in
 * incrementMeter with non-fatal error handling.
 */
describe('Billing meter lifecycle integration tests:', () => {
  let BillingUsage;
  let Subscription;
  let Organization;
  let BillingExtraBalance;
  let BillingWebhookService;
  let BillingMeterService;
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
    Subscription = mongoose.model('Subscription');
    Organization = mongoose.model('Organization');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');

    // Ensure compound indexes (added in feat/billing-admin-toolkit-foundations) are synced
    // to the test DB before tests run. Prevents E11000 flakes on the first resetWeek sweep.
    await Subscription.syncIndexes();

    BillingWebhookService = (await import('../services/billing.webhook.service.js')).default;
    BillingMeterService = (await import('../services/billing.meter.service.js')).default;
    BillingUsageService = (await import('../services/billing.usage.service.js')).default;
    billingEvents = (await import('../lib/events.js')).default;
  });

  beforeEach(async () => {
    await Promise.all([
      BillingUsage.deleteMany({}),
      Subscription.deleteMany({}),
      Organization.deleteMany({}),
      BillingExtraBalance.deleteMany({}),
    ]);
    config.billing.planDefinitions = originalPlanDefinitions;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    billingEvents.removeAllListeners('billing.extras_debit.exhausted');
  });

  afterAll(async () => {
    config.billing.meterMode = originalMeterMode;
    config.billing.planDefinitions = originalPlanDefinitions;
    await mongooseService.disconnect();
  });

  test('plan.changed webhook updates active week quota snapshot mid-week', async () => {
    // Pick two distinct plan ids from the project's enum so the test runs on any downstream.
    // Upstream defaults expose ['free','starter','pro','enterprise'] via planDefinitions;
    // fallback to ['starter','pro'] only when plans array is absent or has fewer than 2 entries.
    const plans = Array.isArray(config.billing?.plans) && config.billing.plans.length >= 2
      ? config.billing.plans
      : ['starter', 'pro'];
    const initialPlan = plans[0];
    const upgradePlan = plans[plans.length - 1];
    const initialVersion = `${initialPlan}-v1`;
    const upgradeVersion = `${upgradePlan}-v2`;

    config.billing.planDefinitions = [
      { planId: initialPlan, version: initialVersion, meterQuota: 100, ratios: { scrap: 1 } },
      { planId: upgradePlan, version: upgradeVersion, meterQuota: 1000, ratios: { scrap: 1 } },
    ];

    const organizationId = new mongoose.Types.ObjectId();
    const weekKey = isoWeekKey(new Date());
    await Organization.create({ _id: organizationId, name: 'Lifecycle Org', slug: 'lifecycle-org', plan: initialPlan });
    await Subscription.create({
      organization: organizationId,
      stripeCustomerId: 'cus_lifecycle',
      stripeSubscriptionId: 'sub_lifecycle',
      plan: initialPlan,
      status: 'active',
    });
    await BillingUsage.create({
      organizationId,
      month: '2026-05',
      weekKey,
      counters: {},
      meterUsed: 25,
      meterQuota: 100,
      planVersion: initialVersion,
      meterBreakdown: { scrap: 25 },
      consumedAttributionKeys: [],
    });

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_lifecycle',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        current_period_start: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
        cancel_at_period_end: false,
        items: { data: [{ price: { metadata: { planId: upgradePlan } } }] },
      },
      {
        data: {
          previous_attributes: {
            items: { data: [{ price: { metadata: { planId: initialPlan } } }] },
          },
        },
      },
    );

    const usage = await BillingUsage.findOne({ organizationId, weekKey }).lean();
    expect(usage.meterQuota).toBe(1000);
    expect(usage.planVersion).toBe(upgradeVersion);
    expect(usage.meterUsed).toBe(25);
    expect(usage.meterBreakdown).toEqual({ scrap: 25 });
  });

  test('attribute applies usage inline — no outbox collection created', async () => {
    config.billing.planDefinitions = [
      { planId: 'pro', version: 'pro-v1', meterQuota: 100000, ratios: { scrap: 1 } },
    ];
    config.billing.meter = { ...(config.billing.meter ?? {}), ratioVersion: 'pro-v1' };

    const organizationId = new mongoose.Types.ObjectId();
    await Subscription.create({
      organization: organizationId,
      plan: 'pro',
      status: 'active',
    });

    const result = await BillingMeterService.attribute(
      {
        _id: new mongoose.Types.ObjectId(),
        costs: { scrap: 0.01 },
        planId: 'pro',
        planVersion: 'pro-v1',
      },
      organizationId.toString(),
    );

    // Attribution succeeded inline — applied=true, meterUsed > 0
    expect(result.applied).toBe(true);
    expect(result.meterUsed).toBeGreaterThan(0);
    // No extras consumed since within quota
    expect(result.extrasConsumed).toBe(0);

    // BillingUsage doc exists with the attributed units
    const usage = await BillingUsage.findOne({ organizationId }).lean();
    expect(usage).not.toBeNull();
    expect(usage.meterUsed).toBe(result.meterUsed);
  });

  test('attribute with overflow debits extras inline — no outbox doc persisted', async () => {
    config.billing.planDefinitions = [
      { planId: 'pro', version: 'pro-v1', meterQuota: 5, ratios: { scrap: 1 } },
    ];
    config.billing.meter = { ...(config.billing.meter ?? {}), ratioVersion: 'pro-v1' };

    const organizationId = new mongoose.Types.ObjectId();
    await Subscription.create({
      organization: organizationId,
      plan: 'pro',
      status: 'active',
    });
    await BillingExtraBalance.create({
      organization: organizationId,
      ledger: [{ kind: 'topup', amount: 100, stripeSessionId: 'cs_lifecycle_overflow' }],
      cachedBalance: 100,
    });

    const result = await BillingMeterService.attribute(
      {
        _id: new mongoose.Types.ObjectId(),
        costs: { scrap: 0.01 },
        planId: 'pro',
        planVersion: 'pro-v1',
      },
      organizationId.toString(),
    );

    // Applied = true, and extras consumed inline (meterUsed > quota)
    expect(result.applied).toBe(true);
    expect(result.extrasConsumed).toBeGreaterThan(0);

    // Balance was debited inline — lower than initial 100
    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balance.cachedBalance).toBeLessThan(100);

    // No outbox collection exists (model not registered)
    const collections = await mongoose.connection.db.listCollections({ name: 'billingmeteroutboxes' }).toArray();
    expect(collections).toHaveLength(0);
  });

  test('incrementMeter creates BillingUsage doc with correct meter snapshot', async () => {
    config.billing.planDefinitions = [
      { planId: 'free', version: 'free-v1', meterQuota: 500, ratios: { scrap: 1 } },
    ];

    const organizationId = new mongoose.Types.ObjectId();
    await Subscription.create({
      organization: organizationId,
      plan: 'free',
      status: 'active',
    });

    const result = await BillingUsageService.incrementMeter(
      organizationId.toString(),
      10,
      { scrap: 10 },
      `${organizationId.toString()}:initial`,
    );

    expect(result.applied).toBe(true);
    expect(result.meterUsed).toBe(10);
    expect(result.extrasConsumed).toBe(0);

    const usage = await BillingUsage.findOne({ organizationId }).lean();
    expect(usage.meterUsed).toBe(10);
    expect(usage.meterQuota).toBe(500);
    expect(usage.planVersion).toBe('free-v1');
    expect(usage.consumedAttributionKeys).toContain(`${organizationId.toString()}:initial`);
  });
});
