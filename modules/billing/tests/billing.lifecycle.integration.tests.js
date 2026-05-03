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
 */
describe('Billing meter lifecycle integration tests:', () => {
  let BillingUsage;
  let BillingPlan;
  let Subscription;
  let Organization;
  let BillingMeterOutbox;
  let BillingExtraBalance;
  let BillingWebhookService;
  let BillingUsageService;
  let BillingMeterService;
  let BillingMeterOutboxService;
  let BillingMeterOutboxRepository;
  let BillingPlanService;
  let billingEvents;
  let originalMeterMode;

  /**
   * @param {string} planId - Plan identifier.
   * @param {string} version - Plan version.
   * @param {number} meterQuota - Meter quota.
   * @returns {Promise<Object>} Created plan document.
   */
  const createActivePlan = (planId, version, meterQuota) =>
    BillingPlan.create({
      planId,
      version,
      meterQuota,
      ratios: { scrap: 1 },
      active: true,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveUntil: null,
    });

  beforeAll(async () => {
    originalMeterMode = config.billing.meterMode;
    config.billing.meterMode = true;
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingUsage = mongoose.model('BillingUsage');
    BillingPlan = mongoose.model('BillingPlan');
    Subscription = mongoose.model('Subscription');
    Organization = mongoose.model('Organization');
    BillingMeterOutbox = mongoose.model('BillingMeterOutbox');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');

    BillingWebhookService = (await import('../services/billing.webhook.service.js')).default;
    BillingUsageService = (await import('../services/billing.usage.service.js')).default;
    BillingMeterService = (await import('../services/billing.meter.service.js')).default;
    BillingMeterOutboxService = (await import('../services/billing.meter.outbox.service.js')).default;
    BillingMeterOutboxRepository = (await import('../repositories/billing.meter.outbox.repository.js')).default;
    BillingPlanService = (await import('../services/billing.plan.service.js')).default;
    billingEvents = (await import('../lib/events.js')).default;

    await BillingMeterOutbox.collection.createIndex({ idempotencyKey: 1 }, { unique: true });
  });

  beforeEach(async () => {
    await Promise.all([
      BillingUsage.deleteMany({}),
      BillingPlan.deleteMany({}),
      Subscription.deleteMany({}),
      Organization.deleteMany({}),
      BillingMeterOutbox.deleteMany({}),
      BillingExtraBalance.deleteMany({}),
    ]);
    for (const planId of config.billing.plans ?? []) {
      BillingPlanService.invalidateCache(planId);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    billingEvents.removeAllListeners('billing.extras_debit.exhausted');
  });

  afterAll(async () => {
    config.billing.meterMode = originalMeterMode;
    await mongooseService.disconnect();
  });

  test('plan.changed webhook updates active week quota snapshot mid-week', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const weekKey = isoWeekKey(new Date());
    await Organization.create({ _id: organizationId, name: 'Lifecycle Org', slug: 'lifecycle-org', plan: 'starter' });
    await createActivePlan('pro', 'pro-v2', 1000);
    await Subscription.create({
      organization: organizationId,
      stripeCustomerId: 'cus_lifecycle',
      stripeSubscriptionId: 'sub_lifecycle',
      plan: 'starter',
      status: 'active',
    });
    await BillingUsage.create({
      organizationId,
      month: '2026-05',
      weekKey,
      counters: {},
      meterUsed: 25,
      meterQuota: 100,
      planVersion: 'starter-v1',
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
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      },
      {
        data: {
          previous_attributes: {
            items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
          },
        },
      },
    );

    const usage = await BillingUsage.findOne({ organizationId, weekKey }).lean();
    expect(usage.meterQuota).toBe(1000);
    expect(usage.planVersion).toBe('pro-v2');
    expect(usage.meterUsed).toBe(25);
    expect(usage.meterBreakdown).toEqual({ scrap: 25 });
  });

  test('attribute returns optimistically and leaves pending outbox when extras debit is not applied', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    await createActivePlan('pro', 'pro-v1', 5);
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

    expect(result).toEqual({ applied: true, meterUsed: 10, extrasConsumed: 5 });
    const outbox = await BillingMeterOutbox.findOne({ organizationId }).lean();
    expect(outbox.status).toBe('pending');
    expect(outbox.extrasUnits).toBe(5);
  });

  test('retry service commits successful debit and emits alert after exhausted failures', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const committedKey = '507f1f77bcf86cd799439011:initial';
    const failedKey = '507f1f77bcf86cd799439022:initial';
    const exhaustedEvents = [];
    billingEvents.on('billing.extras_debit.exhausted', (payload) => exhaustedEvents.push(payload));

    await BillingExtraBalance.create({
      organization: organizationId,
      ledger: [{ kind: 'topup', amount: 100, stripeSessionId: 'cs_retry' }],
      cachedBalance: 100,
    });
    await BillingMeterOutbox.create({
      organizationId,
      idempotencyKey: committedKey,
      extrasUnits: 40,
      status: 'pending',
      lastAttemptedAt: null,
    });
    await BillingMeterOutbox.create({
      organizationId,
      idempotencyKey: failedKey,
      extrasUnits: 500,
      status: 'pending',
      attempts: 4,
      lastAttemptedAt: null,
    });

    const result = await BillingMeterOutboxService.retryPendingExtrasDebits(5 * 60 * 1000, 100);

    expect(result).toEqual({ scanned: 2, committed: 1, failedAttempts: 1, exhausted: 1 });
    const committed = await BillingMeterOutbox.findOne({ idempotencyKey: committedKey }).lean();
    const failed = await BillingMeterOutbox.findOne({ idempotencyKey: failedKey }).lean();
    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(committed.status).toBe('committed');
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(5);
    expect(balance.cachedBalance).toBe(60);
    expect(exhaustedEvents).toEqual([
      expect.objectContaining({
        organizationId: organizationId.toString(),
        idempotencyKey: failedKey,
        extrasUnits: 500,
        attempts: 5,
      }),
    ]);
  });

  test('concurrent failed-attempt accounting emits exactly one exhausted event', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const exhaustedEvents = [];
    billingEvents.on('billing.extras_debit.exhausted', (payload) => exhaustedEvents.push(payload));

    const row = await BillingMeterOutbox.create({
      organizationId,
      idempotencyKey: '507f1f77bcf86cd799439099:initial',
      extrasUnits: 500,
      status: 'pending',
      attempts: 0,
      lastAttemptedAt: null,
    });

    const updates = await Promise.all(
      Array.from({ length: 10 }, () =>
        BillingMeterOutboxRepository.markFailedAttempt(row._id, 'extras debit not applied')),
    );

    for (const updated of updates) {
      if (updated?.status === 'failed' && updated.attempts === 5) {
        billingEvents.emit('billing.extras_debit.exhausted', {
          organizationId: organizationId.toString(),
          idempotencyKey: row.idempotencyKey,
          extrasUnits: row.extrasUnits,
          attempts: updated.attempts,
          lastError: updated.lastError,
        });
      }
    }

    const failed = await BillingMeterOutbox.findById(row._id).lean();
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(5);
    expect(updates.filter((updated) => updated?.status === 'failed' && updated.attempts === 5)).toHaveLength(1);
    expect(exhaustedEvents).toHaveLength(1);
  });

  test('outbox E11000 after meter increment returns existing row instead of failing', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const idempotencyKey = '507f1f77bcf86cd799439088:initial';
    await createActivePlan('pro', 'pro-v1', 5);
    await Subscription.create({
      organization: organizationId,
      plan: 'pro',
      status: 'active',
    });
    const existingOutbox = await BillingMeterOutbox.create({
      organizationId,
      idempotencyKey,
      extrasUnits: 5,
      status: 'pending',
    });

    const result = await BillingUsageService.incrementMeterWithOutbox(
      organizationId.toString(),
      10,
      { scrap: 10 },
      idempotencyKey,
    );

    const outboxRows = await BillingMeterOutbox.find({ idempotencyKey }).lean();
    expect(result.applied).toBe(true);
    expect(result.extrasConsumed).toBe(5);
    expect(String(result.outbox._id)).toBe(String(existingOutbox._id));
    expect(outboxRows).toHaveLength(1);
  });
});
