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

    // Mock Stripe so handleCheckoutCompleted can call stripe.subscriptions.retrieve without a
    // real network call — mirrors billing.webhook.integration.tests.js. Only handleCheckoutCompleted
    // and handleCheckoutPaymentCompleted read getStripe() in this service; neither of the other
    // handlers exercised in this file (handleSubscriptionUpdated, handleSubscriptionCreated,
    // BillingMeterService.attribute, BillingUsageService.incrementMeter) touch it, so this mock
    // is inert for those tests.
    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => ({
        subscriptions: {
          retrieve: jest.fn().mockResolvedValue({ status: 'active' }),
        },
      })),
    }));

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

  test('checkout activation refreshes the active week quota snapshot and attribution reads the live quota', async () => {
    // Two distinct plan tiers from the project's enum, same rationale as the test above: this
    // repo's validPlans enum (billing.webhook.service.js) is frozen at import time from
    // config.billing.plans, not the planDefinitions this test overrides below — so pick real,
    // already-valid plan ids rather than hardcoding literals.
    const plans = Array.isArray(config.billing?.plans) && config.billing.plans.length >= 2
      ? config.billing.plans
      : ['starter', 'pro'];
    const initialPlan = plans[0];
    const upgradePlan = plans[plans.length - 1];
    const initialVersion = `${initialPlan}-v1`;
    const upgradeVersion = `${upgradePlan}-v2`;
    const upgradeQuota = 1000;

    config.billing.planDefinitions = [
      { planId: initialPlan, version: initialVersion, meterQuota: 0, ratios: { scrap: 1 } },
      { planId: upgradePlan, version: upgradeVersion, meterQuota: upgradeQuota, ratios: { scrap: 1 } },
    ];

    const organizationId = new mongoose.Types.ObjectId();
    const weekKey = isoWeekKey(new Date());
    await Organization.create({ _id: organizationId, name: 'Checkout Activation Org', slug: 'checkout-activation-org', plan: initialPlan });
    await Subscription.create({
      organization: organizationId,
      stripeCustomerId: 'cus_checkout_activation',
      stripeSubscriptionId: 'sub_checkout_activation',
      plan: initialPlan,
      status: 'active',
    });

    // Current-week doc pre-exists under the initial plan (created earlier that day, before checkout
    // completed) — reproduces the latent gap: no activation handler ever rotated this snapshot, so
    // it stayed stale at quota=0 after the mid-week upgrade. organizationId must be the ObjectId,
    // not its string form — the schema field is ObjectId-typed.
    await BillingUsage.create({
      organizationId,
      month: '2026-07',
      weekKey,
      counters: {},
      meterUsed: 500,
      meterQuota: 0,
      planVersion: initialVersion,
      meterBreakdown: { scrap: 500 },
      consumedAttributionKeys: [],
    });

    await BillingWebhookService.handleCheckoutCompleted(
      {
        customer: 'cus_checkout_activation',
        subscription: 'sub_checkout_activation',
        metadata: { organizationId: organizationId.toString(), plan: upgradePlan },
      },
      { id: 'evt_checkout_activation', created: Math.floor(Date.now() / 1000) },
    );

    // (a) refresh-on-activation: the stored week snapshot must be rotated to the new plan's quota.
    const usageAfterActivation = await BillingUsage.findOne({ organizationId, weekKey }).lean();
    expect(usageAfterActivation.meterQuota).toBe(upgradeQuota);
    expect(usageAfterActivation.planVersion).toBe(upgradeVersion);
    expect(usageAfterActivation.meterUsed).toBe(500);

    // (b) live-quota attribution: further usage is measured against the live upgraded quota, so it
    // stays within quota (500 + 50 = 550 < 1000) and never drains extras.
    const result = await BillingUsageService.incrementMeter(
      organizationId.toString(),
      50,
      { scrap: 50 },
      `${organizationId.toString()}:post-activation`,
    );

    expect(result.applied).toBe(true);
    expect(result.meterUsed).toBe(550);
    expect(result.meterQuota).toBe(upgradeQuota);
    expect(result.extrasConsumed).toBe(0);

    // No extras balance/ledger doc was ever created — quota-first, extras untouched.
    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balance).toBeNull();
  });

  test('subscription.created (existing row) refreshes the active week quota snapshot on a mid-week plan change', async () => {
    const plans = Array.isArray(config.billing?.plans) && config.billing.plans.length >= 2
      ? config.billing.plans
      : ['starter', 'pro'];
    const initialPlan = plans[0];
    const upgradePlan = plans[plans.length - 1];
    const initialVersion = `${initialPlan}-v1`;
    const upgradeVersion = `${upgradePlan}-v2`;
    const upgradeQuota = 2000;

    config.billing.planDefinitions = [
      { planId: initialPlan, version: initialVersion, meterQuota: 0, ratios: { scrap: 1 } },
      { planId: upgradePlan, version: upgradeVersion, meterQuota: upgradeQuota, ratios: { scrap: 1 } },
    ];

    const organizationId = new mongoose.Types.ObjectId();
    const weekKey = isoWeekKey(new Date());
    await Organization.create({ _id: organizationId, name: 'Subscription Created Org', slug: 'subscription-created-org', plan: initialPlan });
    // Existing row (found via stripeSubscriptionId) exercises the "existing row" branch of
    // handleSubscriptionCreated — a subscription.created delivered for an already-known
    // subscription (e.g. a Dashboard-driven plan swap) rather than a fresh checkout.
    await Subscription.create({
      organization: organizationId,
      stripeCustomerId: 'cus_subscription_created',
      stripeSubscriptionId: 'sub_subscription_created',
      plan: initialPlan,
      status: 'active',
    });
    await BillingUsage.create({
      organizationId,
      month: '2026-07',
      weekKey,
      counters: {},
      meterUsed: 300,
      meterQuota: 0,
      planVersion: initialVersion,
      meterBreakdown: { scrap: 300 },
      consumedAttributionKeys: [],
    });

    await BillingWebhookService.handleSubscriptionCreated(
      {
        id: 'sub_subscription_created',
        customer: 'cus_subscription_created',
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
        items: { data: [{ price: { metadata: { planId: upgradePlan } } }] },
      },
      { id: 'evt_subscription_created', created: Math.floor(Date.now() / 1000) },
    );

    const usageAfterActivation = await BillingUsage.findOne({ organizationId, weekKey }).lean();
    expect(usageAfterActivation.meterQuota).toBe(upgradeQuota);
    expect(usageAfterActivation.planVersion).toBe(upgradeVersion);
    expect(usageAfterActivation.meterUsed).toBe(300);

    const subscription = await Subscription.findOne({ organization: organizationId }).lean();
    expect(subscription.plan).toBe(upgradePlan);
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
