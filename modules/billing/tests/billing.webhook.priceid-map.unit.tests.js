/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.webhook.service.js — priceId map fix + new code paths:
 *   - buildPriceIdToPlanMap + resolvePlan via priceId map (fix: price.metadata.planId is empty in real Stripe webhook payloads)
 *   - cancelAt / cancelAtPeriodEnd sync on customer.subscription.updated
 *   - handleSubscriptionCreated safety-net handler (race-safe upsert)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock factory
// ─────────────────────────────────────────────────────────────────────────────
const makeBaseSetup = (configOverride = {}) => {
  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  const mockSubscriptionRepository = {
    findByOrganization: jest.fn(),
    findByStripeCustomerId: jest.fn(),
    findByStripeSubscriptionId: jest.fn(),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn(),
    updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
  };

  const mockOrganizationRepository = { setPlan: jest.fn().mockResolvedValue({}) };
  const mockResetService = {
    resetWeek: jest.fn().mockResolvedValue({}),
    forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
  };
  const mockEvents = { emit: jest.fn() };
  const mockStripe = { subscriptions: { retrieve: jest.fn() } };

  const defaultConfig = {
    billing: {
      plans: ['free', 'starter', 'pro', 'enterprise'],
      meterMode: true,
    },
    stripe: {
      prices: {
        starter: { monthly: 'price_starter_monthly', annual: 'price_starter_annual' },
        pro: { monthly: 'price_pro_monthly', annual: 'price_pro_annual' },
      },
    },
  };

  jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({ default: mockSubscriptionRepository }));
  jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
    default: { wasProcessed: jest.fn().mockResolvedValue(false), tryRecord: jest.fn().mockResolvedValue({ recorded: true }) },
  }));
  jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({ default: mockOrganizationRepository }));
  jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: { creditPack: jest.fn(), refundPartial: jest.fn() } }));
  jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: mockResetService }));
  jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn(() => mockStripe) }));
  jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  }));
  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: { ...defaultConfig, ...configOverride },
  }));
  jest.unstable_mockModule('mongoose', () => ({
    default: {
      Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
      model: () => ({}),
    },
  }));
  // Mock the failed-backfill repository so the retry recorder is a no-op in unit tests
  // (does not suppress the retryWithBackoff setTimeout delays themselves — tests that exercise
  // retry pathways still pay the real delay, so keep retry attempt counts low in fixtures).
  jest.unstable_mockModule('../repositories/billing.failedBackfill.repository.js', () => ({
    default: { record: jest.fn().mockResolvedValue({}) },
  }));

  return { orgId, subId, mockSubscriptionRepository, mockOrganizationRepository, mockResetService, mockEvents, mockStripe };
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — resolvePlan via priceId map (the P0 fix)
// ─────────────────────────────────────────────────────────────────────────────
describe('resolvePlan via priceId map (P0 fix — price.metadata.planId is empty in real Stripe webhooks):', () => {
  let BillingWebhookService;
  let mocks;

  beforeEach(async () => {
    jest.resetModules();
    mocks = makeBaseSetup();
    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('resolves plan from priceId map when price.metadata.planId is absent (real Stripe webhook)', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    // Real Stripe webhook: price.metadata is empty, but price.id is present
    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_real_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_real_1',
      expect.objectContaining({ plan: 'pro' }),
      'subscription',
    );
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(mocks.orgId, 'pro');
  });

  test('resolves annual priceId to correct plan', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_starter_annual', metadata: {} } }] },
      },
      { id: 'evt_annual_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_annual_1',
      expect.objectContaining({ plan: 'starter' }),
      'subscription',
    );
  });

  test('#3970: retains current plan (does NOT force free) + emits alert when priceId is unknown and metadata is empty', async () => {
    // Existing paid org — an unresolvable price on a webhook must never silently downgrade it.
    const existing = { _id: mocks.subId, organization: mocks.orgId, plan: 'pro' };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_unknown_xyz', metadata: {} } }] },
      },
      { id: 'evt_unknown_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_unknown_1',
      expect.objectContaining({ plan: 'pro' }),
      'subscription',
    );
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(mocks.orgId, 'pro');
    expect(mocks.mockEvents.emit).toHaveBeenCalledWith(
      'billing.webhook.plan_unresolved',
      expect.objectContaining({ organizationId: mocks.orgId, retainedPlan: 'pro', hadKnownPlan: true }),
    );
  });

  test('#3970: a genuinely-free price (metadata.planId=free) still resolves to free, no alert', async () => {
    // Distinguishes a REAL free plan (resolvable via the shared resolver) from the unresolvable
    // case above — 'free' must stay reachable as a normal resolution, not just a fallback.
    const existing = { _id: mocks.subId, organization: mocks.orgId, plan: 'pro' };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_downgrade_to_free', metadata: { planId: 'free' } } }] },
      },
      { id: 'evt_free_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_free_1',
      expect.objectContaining({ plan: 'free' }),
      'subscription',
    );
    expect(mocks.mockEvents.emit).not.toHaveBeenCalledWith('billing.webhook.plan_unresolved', expect.anything());
  });

  test('legacy fallback: uses price.metadata.planId when priceId not in map (e.g. test fixtures)', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    // priceId not in the config map, but metadata.planId is set (e.g. test fixture)
    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_fixture_123', metadata: { planId: 'pro' } } }] },
      },
      { id: 'evt_legacy_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_legacy_1',
      expect.objectContaining({ plan: 'pro' }),
      'subscription',
    );
  });

  test('priceId map lookup takes priority over metadata.planId', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    // priceId resolves to 'starter' but metadata says 'pro' — priceId map wins
    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: { data: [{ price: { id: 'price_starter_monthly', metadata: { planId: 'pro' } } }] },
      },
      { id: 'evt_priority_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_priority_1',
      expect.objectContaining({ plan: 'starter' }),
      'subscription',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — cancelAt / cancelAtPeriodEnd sync
// ─────────────────────────────────────────────────────────────────────────────
describe('handleSubscriptionUpdated — cancelAt/cancelAtPeriodEnd sync:', () => {
  let BillingWebhookService;
  let mocks;

  beforeEach(async () => {
    jest.resetModules();
    mocks = makeBaseSetup();
    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('writes cancelAtPeriodEnd=true and cancelAt as Date when Stripe signals pending cancel', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    const cancelAt = 1750000000; // unix seconds

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        cancel_at_period_end: true,
        cancel_at: cancelAt,
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_cancel_1', created: 1700000100, data: { previous_attributes: {} } },
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      mocks.subId,
      1700000100,
      'evt_cancel_1',
      expect.objectContaining({
        cancelAtPeriodEnd: true,
        cancelAt: new Date(cancelAt * 1000),
      }),
      'subscription',
    );
  });

  test('clears cancelAt to null when cancel is revoked (cancel_at=null)', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        cancel_at_period_end: false,
        cancel_at: null,
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_cancel_2', created: 1700000100, data: { previous_attributes: {} } },
    );

    const callArg = mocks.mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
    expect(callArg.cancelAtPeriodEnd).toBe(false);
    expect(callArg.cancelAt).toBeNull();
  });

  test('does NOT write cancelAt when cancel_at field is absent from payload', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        // No cancel_at_period_end, no cancel_at
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_cancel_3', created: 1700000100, data: { previous_attributes: {} } },
    );

    const callArg = mocks.mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
    expect(callArg).not.toHaveProperty('cancelAtPeriodEnd');
    expect(callArg).not.toHaveProperty('cancelAt');
  });

  test('does NOT write cancelAtPeriodEnd when not a boolean', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        cancel_at_period_end: undefined, // not a boolean
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_cancel_4', created: 1700000100, data: { previous_attributes: {} } },
    );

    const callArg = mocks.mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
    expect(callArg).not.toHaveProperty('cancelAtPeriodEnd');
  });

  test('cancelAt unix-seconds → JS Date conversion is correct', async () => {
    const existing = { _id: mocks.subId, organization: mocks.orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    const cancelAtUnix = 1735689600; // 2025-01-01 00:00:00 UTC

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        cancel_at_period_end: true,
        cancel_at: cancelAtUnix,
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      },
      { id: 'evt_cancel_5', created: 1700000100, data: { previous_attributes: {} } },
    );

    const callArg = mocks.mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
    expect(callArg.cancelAt).toBeInstanceOf(Date);
    expect(callArg.cancelAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — handleSubscriptionCreated safety-net handler
// ─────────────────────────────────────────────────────────────────────────────
describe('handleSubscriptionCreated — safety-net handler:', () => {
  let BillingWebhookService;
  let mocks;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();
    mocks = makeBaseSetup();
    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  const makeEvent = (overrides = {}) => ({ id: 'evt_created', created: 1700000200, ...overrides });
  const makeSubscription = (overrides = {}) => ({
    id: 'sub_new',
    status: 'active',
    customer: 'cus_abc',
    items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
    ...overrides,
  });

  test('normal checkout flow: existing doc found via subscriptionId — updateIfEventNewer called', async () => {
    const existing = { _id: subId, organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      subId,
      1700000200,
      'evt_created',
      expect.objectContaining({ plan: 'pro', status: 'active' }),
      'subscription',
    );
    expect(mocks.mockSubscriptionRepository.create).not.toHaveBeenCalled();
  });

  test('existing doc: syncOrganizationPlan called after successful update', async () => {
    const existing = { _id: subId, organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
  });

  test('existing doc: forceRotateForPlanChange called (preserveUsage: true) after successful update', async () => {
    const existing = { _id: subId, organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
  });

  test('existing doc: forceRotateForPlanChange error is non-fatal (logged, does not throw)', async () => {
    const existing = { _id: subId, organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mocks.mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db unavailable'));

    const { default: mockLogger } = await import('../../../lib/services/logger.js');

    await expect(
      BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent()),
    ).resolves.not.toThrow();
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[billing.webhook] forceRotateForPlanChange failed after subscription.created (existing row)',
      expect.objectContaining({ organizationId: orgId }),
    );
  });

  test('existing doc: stale event — updateIfEventNewer returns null, syncOrganizationPlan NOT called', async () => {
    const existing = { _id: subId, organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
    mocks.mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
  });

  test('#3970: existing doc — retains current plan (does NOT force free) + emits alert on unresolvable price', async () => {
    const existing = { _id: subId, organization: orgId, plan: 'enterprise' };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({ items: { data: [{ price: { id: 'price_unmapped_manual', metadata: {} } }] } }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      subId,
      1700000200,
      'evt_created',
      expect.objectContaining({ plan: 'enterprise' }),
      'subscription',
    );
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'enterprise');
    expect(mocks.mockEvents.emit).toHaveBeenCalledWith(
      'billing.webhook.plan_unresolved',
      expect.objectContaining({ organizationId: orgId, retainedPlan: 'enterprise', hadKnownPlan: true }),
    );
  });

  test('Dashboard subscription: no existing doc via subscriptionId, found via customerId — creates row', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockSubscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organization: orgId,
        stripeCustomerId: 'cus_abc',
        stripeSubscriptionId: 'sub_new',
        plan: 'pro',
        status: 'active',
      }),
    );
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
  });

  test('Dashboard subscription: create succeeds — forceRotateForPlanChange called (preserveUsage: true)', async () => {
    // Unit-level coverage of the new-row branch's rotation call. A real-DB integration test
    // cannot exercise this: `organization` is a unique field on the Subscription schema
    // (billing.subscription.model.mongoose.js), so `orgSub` being found via
    // findByStripeCustomerId always means a row already exists for that org, and a real
    // Subscription.create() for the same org always throws E11000 (see the sibling
    // "race condition: E11000" test below) before reaching this call. Mocking the repository
    // lets us assert the rotation wiring on the success branch in isolation.
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
  });

  test('Dashboard subscription: forceRotateForPlanChange error is non-fatal (logged, does not throw)', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);
    mocks.mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db unavailable'));

    const { default: mockLogger } = await import('../../../lib/services/logger.js');

    await expect(
      BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent()),
    ).resolves.not.toThrow();
    // Row creation + plan sync already committed before the rotation call — a rotation
    // failure must not roll those back or propagate.
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[billing.webhook] forceRotateForPlanChange failed after subscription.created (new row)',
      expect.objectContaining({ organizationId: orgId }),
    );
  });

  test('Dashboard subscription: resolves plan from priceId map (no metadata)', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({ items: { data: [{ price: { id: 'price_starter_annual', metadata: {} } }] } }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'starter' }),
    );
  });

  test('#3970: Dashboard subscription — orgSub already carries a plan, retains it (does NOT force free) on unresolvable price', async () => {
    // Multi-subscription edge case: the org already has a Subscription row (found via
    // stripeCustomerId) on plan 'pro'. syncOrganizationPlan writes the shared org-level plan
    // field, so an unresolvable price on this second subscription must not downgrade it.
    const orgSub = { organization: orgId, plan: 'pro' };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({ items: { data: [{ price: { id: 'price_unmapped_manual', metadata: {} } }] } }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'pro' }),
    );
    expect(mocks.mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    expect(mocks.mockEvents.emit).toHaveBeenCalledWith(
      'billing.webhook.plan_unresolved',
      expect.objectContaining({ organizationId: orgId, retainedPlan: 'pro', hadKnownPlan: true }),
    );
  });

  test('#3970: Dashboard subscription — no prior plan reference at all, defaults free on unresolvable price + alerts', async () => {
    // Genuinely new org/customer mapping with no plan on record yet — least-harmful default.
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({ items: { data: [{ price: { id: 'price_unmapped_manual', metadata: {} } }] } }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'free' }),
    );
    expect(mocks.mockEvents.emit).toHaveBeenCalledWith(
      'billing.webhook.plan_unresolved',
      expect.objectContaining({ organizationId: orgId, retainedPlan: 'free', hadKnownPlan: false }),
    );
  });

  test('no existing doc and no customer mapping — skip (log info, no create)', async () => {
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

    const { default: mockLogger } = await import('../../../lib/services/logger.js');
    await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(mocks.mockSubscriptionRepository.create).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[billing.webhook] subscription.created — cannot resolve org, will reconcile via next event',
      expect.any(Object),
    );
  });

  test('no existing doc and null customer — skip (no findByStripeCustomerId call)', async () => {
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({ customer: null }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.findByStripeCustomerId).not.toHaveBeenCalled();
    expect(mocks.mockSubscriptionRepository.create).not.toHaveBeenCalled();
  });

  test('race condition: E11000 duplicate key on create — returns skip sentinel, does not throw', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);
    const dupErr = new Error('duplicate key');
    dupErr.code = 11000;
    mocks.mockSubscriptionRepository.create.mockRejectedValue(dupErr);

    const result = await BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent());

    expect(result).toEqual({ skipped: true, reason: 'duplicate' });
    // The duplicate-skip return happens before syncOrganizationPlan — rotation must not fire
    // on a row this handler never actually wrote.
    expect(mocks.mockResetService.forceRotateForPlanChange).not.toHaveBeenCalled();
  });

  test('non-duplicate DB error on create — rethrows', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);
    const dbErr = new Error('db unavailable');
    mocks.mockSubscriptionRepository.create.mockRejectedValue(dbErr);

    await expect(
      BillingWebhookService.handleSubscriptionCreated(makeSubscription(), makeEvent()),
    ).rejects.toThrow('db unavailable');
  });

  test('seeds currentPeriodStart when present in subscription', async () => {
    const orgSub = { organization: orgId };
    mocks.mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);
    mocks.mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(orgSub);

    const periodStart = 1700000000;

    await BillingWebhookService.handleSubscriptionCreated(
      makeSubscription({
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} }, current_period_start: periodStart }] },
      }),
      makeEvent(),
    );

    expect(mocks.mockSubscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ currentPeriodStart: new Date(periodStart * 1000) }),
    );
  });
});
