/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, afterEach, test, expect, jest } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for syncOrgFromStripe event-marker race-window closure (Batch 3b).
 *
 * Validates:
 * 1. Admin sync sets lastSubscriptionEventCreatedAt and lastSubscriptionEventId on the DB doc.
 * 2. A stale Stripe webhook (event.created < adminSyncTimestamp) is rejected by updateIfEventNewer
 *    — the DB stays at admin-set values.
 * 3. A fresher Stripe webhook (event.created > adminSyncTimestamp) wins and updates the DB.
 *
 * Architecture note: BillingAdminService is re-imported per test (jest.resetModules) so that
 * mocked Stripe / config are picked up fresh. SubscriptionRepository is imported once in
 * beforeAll (after loadModels) and re-injected via unstable_mockModule to avoid the
 * MissingSchemaError that happens when it re-registers mongoose.model() on a reset module graph.
 */
describe('syncOrgFromStripe — event marker race-window closure integration tests:', () => {
  let Subscription;
  let Organization;
  let SubscriptionRepository;
  let BillingAdminService;
  let mockStripeInstance;

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();

    Subscription = mongoose.model('Subscription');
    Organization = mongoose.model('Organization');
    await Subscription.syncIndexes();

    // Import real SubscriptionRepository once — it references mongoose.model('Subscription')
    // at import time, so it must be imported after loadModels. The instance is reused across
    // all tests via unstable_mockModule injection (see beforeEach).
    SubscriptionRepository = (await import('../repositories/billing.subscription.repository.js')).default;
  });

  beforeEach(async () => {
    jest.resetModules();
    await Promise.all([
      Subscription.deleteMany({}),
      Organization.deleteMany({}),
    ]);

    mockStripeInstance = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'sub_test_batch3b',
          status: 'active',
          current_period_start: Math.floor(Date.now() / 1000) - 86400,
          items: {
            data: [{ price: { metadata: { planId: 'pro' } } }],
          },
        }),
      },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        stripe: { secretKey: 'sk_test_batch3b_fake' },
        billing: {
          plans: config.billing?.plans ?? ['free', 'starter', 'pro', 'enterprise'],
          statuses: config.billing?.statuses ?? ['active', 'trialing', 'past_due', 'unpaid', 'canceled'],
        },
      },
    }));

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn().mockReturnValue(mockStripeInstance),
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: {
        setPlan: jest.fn().mockResolvedValue({}),
      },
    }));

    // Inject the real SubscriptionRepository (already bound to the registered mongoose model)
    // so syncOrgFromStripe hits the real DB while Stripe stays mocked.
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: SubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        listDeadLetters: jest.fn(),
        purgeDeadLetterByEventId: jest.fn(),
        deleteByEventId: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: { creditCompensation: jest.fn() },
    }));

    jest.unstable_mockModule('../services/billing.webhook.service.js', () => ({
      default: {
        withIdempotency: jest.fn(),
        handleCheckoutSessionCompleted: jest.fn(),
        handleSubscriptionCreated: jest.fn(),
        handleSubscriptionUpdated: jest.fn(),
        handleSubscriptionDeleted: jest.fn(),
        handleInvoicePaymentFailed: jest.fn(),
        handleInvoicePaymentSucceeded: jest.fn(),
        handleChargeRefunded: jest.fn(),
        handleCustomerDeleted: jest.fn(),
        handleChargeDisputeCreated: jest.fn(),
        handleChargeDisputeFundsWithdrawn: jest.fn(),
        handleChargeDisputeFundsReinstated: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    BillingAdminService = (await import('../services/billing.admin.service.js')).default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('admin sync sets lastSubscriptionEventCreatedAt and lastSubscriptionEventId on the DB doc', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await Organization.create({ _id: orgId, name: 'Batch3b Org', slug: 'batch3b-org', plan: 'free' });
    await Subscription.create({
      organization: orgId,
      stripeCustomerId: 'cus_batch3b_1',
      stripeSubscriptionId: 'sub_test_batch3b',
      plan: 'free',
      status: 'active',
    });

    const before = Math.floor(Date.now() / 1000);
    await BillingAdminService.syncOrgFromStripe(orgId.toString());
    const after = Math.floor(Date.now() / 1000);

    const doc = await Subscription.findOne({ organization: orgId }).lean();

    expect(doc.lastSubscriptionEventCreatedAt).toBeGreaterThanOrEqual(before);
    expect(doc.lastSubscriptionEventCreatedAt).toBeLessThanOrEqual(after);
    expect(typeof doc.lastSubscriptionEventId).toBe('string');
    expect(doc.lastSubscriptionEventId).toMatch(/^admin-sync-\d+$/);
    expect(doc.plan).toBe('pro');
    expect(doc.status).toBe('active');
  });

  test('stale webhook after admin sync is rejected — DB stays at admin-set values', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await Organization.create({ _id: orgId, name: 'Batch3b Org Stale', slug: 'batch3b-org-stale', plan: 'free' });
    await Subscription.create({
      organization: orgId,
      stripeCustomerId: 'cus_batch3b_2',
      stripeSubscriptionId: 'sub_test_batch3b',
      plan: 'free',
      status: 'active',
    });

    await BillingAdminService.syncOrgFromStripe(orgId.toString());

    const docAfterSync = await Subscription.findOne({ organization: orgId }).lean();
    const adminSyncTimestamp = docAfterSync.lastSubscriptionEventCreatedAt;

    // Simulate a stale Stripe webhook: event.created is 1 second before the admin sync
    const staleEventCreatedAt = adminSyncTimestamp - 1;
    const staleEventId = 'evt_stale_before_admin_sync';

    const result = await SubscriptionRepository.updateIfEventNewer(
      docAfterSync._id.toString(),
      staleEventCreatedAt,
      staleEventId,
      { plan: 'free', status: 'canceled' },
      'subscription',
    );

    // updateIfEventNewer must return null (guard blocked the write)
    expect(result).toBeNull();

    const docAfterStale = await Subscription.findOne({ organization: orgId }).lean();
    // DB must remain at admin-set values (plan=pro, status=active)
    expect(docAfterStale.plan).toBe('pro');
    expect(docAfterStale.status).toBe('active');
    expect(docAfterStale.lastSubscriptionEventCreatedAt).toBe(adminSyncTimestamp);
  });

  test('fresher webhook after admin sync wins — DB updates to webhook payload', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await Organization.create({ _id: orgId, name: 'Batch3b Org Fresh', slug: 'batch3b-org-fresh', plan: 'free' });
    await Subscription.create({
      organization: orgId,
      stripeCustomerId: 'cus_batch3b_3',
      stripeSubscriptionId: 'sub_test_batch3b',
      plan: 'free',
      status: 'active',
    });

    await BillingAdminService.syncOrgFromStripe(orgId.toString());

    const docAfterSync = await Subscription.findOne({ organization: orgId }).lean();
    const adminSyncTimestamp = docAfterSync.lastSubscriptionEventCreatedAt;

    // Simulate a fresher Stripe webhook: event.created is 1 second after the admin sync
    const freshEventCreatedAt = adminSyncTimestamp + 1;
    const freshEventId = 'evt_fresh_after_admin_sync';

    const plans = config.billing?.plans ?? ['free', 'starter', 'pro', 'enterprise'];
    const targetPlan = plans.find((p) => p !== 'pro') ?? 'starter';

    const result = await SubscriptionRepository.updateIfEventNewer(
      docAfterSync._id.toString(),
      freshEventCreatedAt,
      freshEventId,
      { plan: targetPlan, status: 'canceled' },
      'subscription',
    );

    // updateIfEventNewer must succeed (fresh event wins)
    expect(result).not.toBeNull();

    const docAfterFresh = await Subscription.findOne({ organization: orgId }).lean();
    expect(docAfterFresh.plan).toBe(targetPlan);
    expect(docAfterFresh.status).toBe('canceled');
    expect(docAfterFresh.lastSubscriptionEventCreatedAt).toBe(freshEventCreatedAt);
    expect(docAfterFresh.lastSubscriptionEventId).toBe(freshEventId);
  });
});
