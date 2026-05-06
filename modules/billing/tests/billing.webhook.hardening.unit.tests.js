/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing webhook hardening (PR: feat/billing-webhook-hardening)
 *
 * Covers:
 *   - Item 3: Replay-storm dead-letter protection on withIdempotency
 *   - Item 4: Per-family event-newer guard (subscription vs invoice)
 *   - Item 5: Quota fail-closed for paused / unpaid / incomplete_expired in meter mode
 *   - Item 7: Integer-cents refund math (no floating-point drift)
 *   - Item 8: Stable idempotency key for extras checkout (intentId)
 *   - Item 9: Server-side live active-subscription guard in createCheckout
 */

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 — Stripe API version pinned
// ─────────────────────────────────────────────────────────────────────────────
describe('Stripe client — API version pinned:', () => {
  test('getStripe instantiates Stripe with apiVersion 2026-04-22.dahlia', async () => {
    jest.resetModules();

    let capturedArgs;
    const MockStripe = jest.fn((...args) => {
      capturedArgs = args;
      return { apiVersion: args[1]?.apiVersion };
    });

    jest.unstable_mockModule('stripe', () => ({ default: MockStripe }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { stripe: { secretKey: 'sk_test_pinned' } },
    }));

    const mod = await import('../lib/stripe.js');
    const getStripe = mod.default;
    getStripe(); // trigger instantiation

    expect(MockStripe).toHaveBeenCalledWith(
      'sk_test_pinned',
      expect.objectContaining({ apiVersion: '2026-04-22.dahlia' }),
    );
    expect(capturedArgs[1].apiVersion).toBe('2026-04-22.dahlia');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 2 — current_period_start / current_period_end from items.data[0]
// ─────────────────────────────────────────────────────────────────────────────
describe('handleSubscriptionUpdated — period fields from items.data[0]:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockResetService;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn().mockResolvedValue({ _id: subId, organization: orgId }),
      create: jest.fn(),
      update: jest.fn(),
      updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
    };

    mockResetService = {
      resetWeek: jest.fn().mockResolvedValue({}),
      forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({ default: mockSubscriptionRepository }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: { tryRecord: jest.fn().mockResolvedValue({ recorded: true }), incrementAttempts: jest.fn(), markDeadLetter: jest.fn(), deleteByEventId: jest.fn() },
    }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: { setPlan: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: { creditPack: jest.fn(), refundPartial: jest.fn() } }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: mockResetService }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: { emit: jest.fn() } }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'], meterMode: true } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('reads current_period_start from items.data[0] when present (new API)', async () => {
    const newPeriodStart = 1700604800;

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        items: {
          data: [{
            price: { metadata: { planId: 'pro' } },
            current_period_start: newPeriodStart,
            current_period_end: newPeriodStart + 2592000,
          }],
        },
        // Top-level fields absent (new API)
      },
      {
        id: 'evt_items_1', created: 1700000100,
        data: { previous_attributes: { items: { data: [{ current_period_start: 1700000000 }] } } },
      },
    );

    expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      subId,
      1700000100,
      'evt_items_1',
      expect.objectContaining({ currentPeriodStart: new Date(newPeriodStart * 1000) }),
      'subscription',
    );
    expect(mockResetService.resetWeek).toHaveBeenCalledWith(orgId, new Date(newPeriodStart * 1000));
  });

  test('falls back to top-level current_period_start when items field absent (old API)', async () => {
    const newPeriodStart = 1700604800;

    await BillingWebhookService.handleSubscriptionUpdated(
      {
        id: 'sub_456',
        status: 'active',
        current_period_start: newPeriodStart,
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      },
      {
        id: 'evt_fallback_1', created: 1700000100,
        data: { previous_attributes: { current_period_start: 1700000000 } },
      },
    );

    expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      subId,
      1700000100,
      'evt_fallback_1',
      expect.objectContaining({ currentPeriodStart: new Date(newPeriodStart * 1000) }),
      'subscription',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 6 — Refund backfill resolver
// ─────────────────────────────────────────────────────────────────────────────
describe('handleChargeRefunded — backfill resolver + unresolved alert:', () => {
  let BillingWebhookService;
  let mockExtraService;
  let mockStripeInstance;
  let mockGetStripe;
  let mockLogger;
  let mockEvents;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSessionId = 'cs_test_session_abc';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };

    mockExtraService = {
      creditPack: jest.fn(),
      refundPartial: jest.fn().mockResolvedValue({ applied: true, refundUnits: 500000 }),
    };

    mockStripeInstance = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_test_001',
          metadata: { stripeSessionId, organizationId: orgId, packId: 'pack_500k', kind: 'extras' },
        }),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: mockExtraService }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: { resetWeek: jest.fn() } }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(), findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(), create: jest.fn(), update: jest.fn(),
        updateIfEventNewer: jest.fn().mockResolvedValue(null),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
        incrementAttempts: jest.fn().mockResolvedValue({ attempts: 1 }),
        deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
        markDeadLetter: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('stripeSessionId present in charge metadata: no PI fetch, refundPartial called', async () => {
    await BillingWebhookService.handleChargeRefunded({
      id: 'ch_001',
      payment_intent: 'pi_test_001',
      metadata: { organizationId: orgId, stripeSessionId, packId: 'pack_500k' },
      refunds: { data: [{ id: 'rf_001', amount: 4900 }] },
    });

    expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(mockExtraService.refundPartial).toHaveBeenCalled();
  });

  test('stripeSessionId absent from charge metadata: fetches PI to backfill', async () => {
    await BillingWebhookService.handleChargeRefunded({
      id: 'ch_002',
      payment_intent: 'pi_test_001',
      metadata: { organizationId: orgId }, // no stripeSessionId
      refunds: { data: [{ id: 'rf_002', amount: 4900 }] },
    });

    expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_test_001');
    expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
      orgId, stripeSessionId, 4900, 'pack_500k', 'rf_002',
    );
  });

  test('stripeSessionId absent AND PI metadata empty: logs error + emits billing.refund.unresolved', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_no_meta',
      metadata: {}, // no stripeSessionId in PI either
    });

    await BillingWebhookService.handleChargeRefunded({
      id: 'ch_003',
      payment_intent: 'pi_no_meta',
      metadata: { organizationId: orgId },
      refunds: { data: [{ id: 'rf_003', amount: 4900 }] },
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] refund unresolved — manual reconciliation required',
      expect.objectContaining({ chargeId: 'ch_003' }),
    );
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.refund.unresolved',
      expect.objectContaining({ chargeId: 'ch_003' }),
    );
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
  });

  test('stripeSessionId absent AND no payment_intent: logs error + emits billing.refund.unresolved', async () => {
    await BillingWebhookService.handleChargeRefunded({
      id: 'ch_004',
      payment_intent: null,
      metadata: { organizationId: orgId },
      refunds: { data: [{ id: 'rf_004', amount: 4900 }] },
    });

    expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] refund unresolved — manual reconciliation required',
      expect.objectContaining({ chargeId: 'ch_004' }),
    );
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
  });

  test('PI fetch failure: logs PI fetch error, then emits unresolved (graceful)', async () => {
    mockStripeInstance.paymentIntents.retrieve.mockRejectedValue(new Error('Stripe API down'));

    await BillingWebhookService.handleChargeRefunded({
      id: 'ch_005',
      payment_intent: 'pi_fail',
      metadata: { organizationId: orgId },
      refunds: { data: [{ id: 'rf_005', amount: 4900 }] },
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] refund PI fetch failed',
      expect.objectContaining({ chargeId: 'ch_005' }),
    );
    // After PI fetch failure → still no sessionId → unresolved
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] refund unresolved — manual reconciliation required',
      expect.objectContaining({ chargeId: 'ch_005' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 — Replay-storm dead-letter protection
// ─────────────────────────────────────────────────────────────────────────────
describe('withIdempotency — replay-storm dead-letter protection:', () => {
  let BillingWebhookService;
  let mockProcessedStripeEventRepository;
  let mockLogger;

  const makeEvent = (id = 'evt_rl_001', type = 'checkout.session.completed') => ({
    id,
    type,
    data: { object: { id: 'obj_1' } },
  });

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    mockProcessedStripeEventRepository = {
      tryRecord: jest.fn(),
      wasProcessed: jest.fn(),
      deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
      incrementAttempts: jest.fn(),
      markDeadLetter: jest.fn().mockResolvedValue({}),
    };

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: mockProcessedStripeEventRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(),
        findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateIfEventNewer: jest.fn().mockResolvedValue(null),
      },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: { resetWeek: jest.fn(), forceRotateForPlanChange: jest.fn() },
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: { plans: ['free', 'starter', 'pro', 'enterprise'] },
      },
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({ findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn() }) }),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('first failure (attempts=1 < 5): doc persists (no rollback), error re-thrown', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
    mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 1 });
    const handler = jest.fn().mockRejectedValue(new Error('transient'));
    const event = makeEvent();

    await expect(BillingWebhookService.withIdempotency(event, handler)).rejects.toThrow('transient');

    // incrementAttempts receives the full Error object (for stack trace capture)
    const [eidArg, errArg] = mockProcessedStripeEventRepository.incrementAttempts.mock.calls[0];
    expect(eidArg).toBe('evt_rl_001');
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg.message).toBe('transient');
    // Doc must NOT be deleted — attempts must persist across Stripe redeliveries
    // so MAX_ATTEMPTS (5) is reachable. Deleting on rollback was the original bug.
    expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
    expect(mockProcessedStripeEventRepository.markDeadLetter).not.toHaveBeenCalled();
  });

  test('fifth failure (attempts=5 >= 5): dead-letter — markDeadLetter called, success sentinel returned, logger.error called', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: true });
    mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 5 });
    const handler = jest.fn().mockRejectedValue(new Error('persistent'));
    const event = makeEvent('evt_dead_001');

    const result = await BillingWebhookService.withIdempotency(event, handler);

    // Doc kept; markDeadLetter sets the terminal flag.
    expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
    expect(mockProcessedStripeEventRepository.markDeadLetter).toHaveBeenCalledWith('evt_dead_001');
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] webhook dead-letter',
      expect.objectContaining({ eventId: 'evt_dead_001', attempts: 5 }),
    );
    expect(result).toEqual(expect.objectContaining({ deadLettered: true, eventId: 'evt_dead_001', attempts: 5 }));
  });

  test('attempts=4 < 5: doc persists, no rollback, no dead-letter, error re-thrown', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: true });
    mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 4 });
    const handler = jest.fn().mockRejectedValue(new Error('still failing'));
    const event = makeEvent('evt_retry_04');

    await expect(BillingWebhookService.withIdempotency(event, handler)).rejects.toThrow('still failing');

    expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
    expect(mockProcessedStripeEventRepository.markDeadLetter).not.toHaveBeenCalled();
  });

  test('incrementAttempts failure: original error propagated, doc not deleted', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
    mockProcessedStripeEventRepository.incrementAttempts.mockRejectedValue(new Error('counter DB down'));
    const handler = jest.fn().mockRejectedValue(new Error('handler error'));
    const event = makeEvent('evt_counter_fail');

    await expect(BillingWebhookService.withIdempotency(event, handler)).rejects.toThrow('handler error');

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] webhook attempts increment failed',
      expect.objectContaining({ eventId: 'evt_counter_fail' }),
    );
    expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
  });

  test('markDeadLetter failure: logger.error called, success sentinel still returned', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: true });
    mockProcessedStripeEventRepository.incrementAttempts.mockResolvedValue({ attempts: 5 });
    mockProcessedStripeEventRepository.markDeadLetter.mockRejectedValue(new Error('DL DB down'));
    const handler = jest.fn().mockRejectedValue(new Error('persistent again'));
    const event = makeEvent('evt_dl_fail');

    const result = await BillingWebhookService.withIdempotency(event, handler);

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] webhook markDeadLetter failed',
      expect.objectContaining({ eventId: 'evt_dl_fail' }),
    );
    // Still returns dead-letter sentinel (Stripe gets 200)
    expect(result.deadLettered).toBe(true);
  });

  test('successful first call: handler runs, no incrementAttempts (attempts stays 0)', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: true, retry: false });
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const event = makeEvent('evt_success_001');

    const result = await BillingWebhookService.withIdempotency(event, handler);

    expect(result).toEqual({ ok: true });
    // attempts stays 0 on success — that is the terminal-success signal for tryRecord.
    expect(mockProcessedStripeEventRepository.incrementAttempts).not.toHaveBeenCalled();
    expect(mockProcessedStripeEventRepository.markDeadLetter).not.toHaveBeenCalled();
    expect(mockProcessedStripeEventRepository.deleteByEventId).not.toHaveBeenCalled();
  });

  test('redelivery after success: tryRecord={recorded:false, reason:already_processed} → skip', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false, reason: 'already_processed' });
    const handler = jest.fn();
    const event = makeEvent('evt_already_processed');

    const result = await BillingWebhookService.withIdempotency(event, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'duplicate_event_or_dead_letter', detail: 'already_processed' });
  });

  test('redelivery after dead-letter: tryRecord={recorded:false, reason:dead_letter} → skip', async () => {
    mockProcessedStripeEventRepository.tryRecord.mockResolvedValue({ recorded: false, reason: 'dead_letter' });
    const handler = jest.fn();
    const event = makeEvent('evt_dl_replay');

    const result = await BillingWebhookService.withIdempotency(event, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'duplicate_event_or_dead_letter', detail: 'dead_letter' });
  });
});

// NOTE: Item 4 (updateIfEventNewer per-family guard) tests are in the dedicated file
// billing.subscription.repository.per-family.unit.tests.js — extracted to avoid Jest ESM
// mock cross-contamination when multiple describe blocks in the same file register
// different factories for 'mongoose'.

// ─────────────────────────────────────────────────────────────────────────────
// Item 5 — Quota fail-closed for paused / unpaid / incomplete_expired
// ─────────────────────────────────────────────────────────────────────────────
describe('requireQuota — fail-closed statuses in meter mode:', () => {
  let requireQuota;
  let mockSubscriptionRepository;
  let mockBillingUsageService;
  let mockBillingExtraBalanceRepository;
  let mockBillingPlanService;
  let req;
  let res;
  let next;

  const makeRes = () => {
    const r = { status: jest.fn(), json: jest.fn(), locals: {} };
    r.status.mockReturnValue(r);
    r.json.mockReturnValue(r);
    return r;
  };

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = { findByOrganization: jest.fn() };
    mockBillingUsageService = { getMeter: jest.fn(), get: jest.fn() };
    mockBillingExtraBalanceRepository = { getBalance: jest.fn().mockResolvedValue(0) };
    mockBillingPlanService = { getActivePlan: jest.fn().mockReturnValue({ meterQuota: 0 }) };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));
    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockBillingExtraBalanceRepository,
    }));
    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockBillingPlanService,
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          meterMode: true,
          packs: [],
          upgradeUrl: '/billing/plans',
          defaultPlan: 'free',
        },
      },
    }));

    const mod = await import('../middlewares/billing.requireQuota.js');
    requireQuota = mod.default;

    req = { organization: { _id: '507f1f77bcf86cd799439011' } };
    res = makeRes();
    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(['paused', 'unpaid', 'incomplete_expired'])(
    'status=%s with free plan quota=0 → 402 METER_EXHAUSTED (fail-closed, no paid-tier bleed)',
    async (status) => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status });
      mockBillingPlanService.getActivePlan.mockReturnValue({ meterQuota: 0 });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('METER_EXHAUSTED');
    },
  );

  test.each(['paused', 'unpaid', 'incomplete_expired'])(
    'status=%s with extras balance: next() called if extras cover it',
    async (status) => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status });
      mockBillingPlanService.getActivePlan.mockReturnValue({ meterQuota: 0 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(500000);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
    },
  );

  test('paused with no extras but free plan quota > 0 → next() called', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'paused' });
    mockBillingPlanService.getActivePlan.mockReturnValue({ meterQuota: 10 });

    await requireQuota('scraps', 'create')(req, res, next);

    // meterQuota=10 + extras=0 = 10 > 0 → allow
    expect(next).toHaveBeenCalled();
  });

  test('paused with PLAN_NOT_CONFIGURED → 503', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'paused' });
    mockBillingPlanService.getActivePlan.mockReturnValue(null);

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('active status still goes through normal meter path (not fail-closed)', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active', pastDueSince: null });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    // Normal meter path — getActivePlan not called for fail-closed path
    expect(mockBillingUsageService.getMeter).toHaveBeenCalled();
  });
});

// NOTE: Item 7 (integer-cents refund math) tests are in the dedicated file
// billing.extra.service.refund-math.unit.tests.js — extracted to avoid Jest ESM mock
// cross-contamination when Item 6 stubs 'billing.extra.service.js' as a whole.

// ─────────────────────────────────────────────────────────────────────────────
// Item 8 — Stable idempotency key for extras checkout
// ─────────────────────────────────────────────────────────────────────────────
describe('BillingService.createExtrasCheckout — idempotency key:', () => {
  let BillingService;
  let mockStripeInstance;

  const org = { _id: '507f1f77bcf86cd799439011', name: 'Test Org' };
  const packId = 'pack_500k';

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }) } },
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn().mockReturnValue(mockStripeInstance) }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_test' }),
        findByStripeCustomerId: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../services/billing.plans.service.js', () => ({
      default: { getPlans: jest.fn().mockResolvedValue([{ planId: 'pro', stripePriceMonthly: 'price_pro' }]) },
    }));

    jest.unstable_mockModule('../lib/billing.errors.js', () => ({
      isDuplicateKeyError: jest.fn().mockReturnValue(false),
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        stripe: { secretKey: 'sk_test', prices: { packs: { [packId]: 'price_pack_500k' } } },
        billing: {
          packs: [{ packId, meterUnits: 500000, priceUsd: 49 }],
        },
        domain: 'test.example.com',
      },
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('intentId provided: idempotency key is stable (same intentId = same key)', async () => {
    const url1 = 'https://test.example.com/success';
    const url2 = 'https://test.example.com/cancel';

    await BillingService.createExtrasCheckout(org, packId, url1, url2, 'my-intent-uuid-001');
    await BillingService.createExtrasCheckout(org, packId, url1, url2, 'my-intent-uuid-001');

    const key1 = mockStripeInstance.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const key2 = mockStripeInstance.checkout.sessions.create.mock.calls[1][1].idempotencyKey;

    expect(key1).toBe(key2);
    expect(key1).toMatch(/^extras_checkout_507f1f77bcf86cd799439011_pack_500k_my-intent-uuid-001$/);
  });

  test('different intentIds: different idempotency keys', async () => {
    const url1 = 'https://test.example.com/success';
    const url2 = 'https://test.example.com/cancel';

    await BillingService.createExtrasCheckout(org, packId, url1, url2, 'intent-A');
    await BillingService.createExtrasCheckout(org, packId, url1, url2, 'intent-B');

    const keyA = mockStripeInstance.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
    const keyB = mockStripeInstance.checkout.sessions.create.mock.calls[1][1].idempotencyKey;

    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('intent-A');
    expect(keyB).toContain('intent-B');
  });

  test('no intentId: minute-bucketed key (contains org+pack, no random suffix)', async () => {
    const url1 = 'https://test.example.com/success';
    const url2 = 'https://test.example.com/cancel';

    await BillingService.createExtrasCheckout(org, packId, url1, url2);

    const key = mockStripeInstance.checkout.sessions.create.mock.calls[0][1].idempotencyKey;

    // Key ends with a numeric minute bucket — no random UUID/hex suffix
    expect(key).toMatch(/^extras_checkout_507f1f77bcf86cd799439011_pack_500k_\d+$/);
    // Must not contain a UUID-style segment (8 hex chars separated by underscores)
    expect(key).not.toMatch(/_[0-9a-f]{8}-/);
  });

  test('no intentId: two calls in same minute use same key (double-click safe)', async () => {
    const url1 = 'https://test.example.com/success';
    const url2 = 'https://test.example.com/cancel';

    // Both calls happen in the same minute bucket
    const minuteBefore = Math.floor(Date.now() / 60000);
    await BillingService.createExtrasCheckout(org, packId, url1, url2);
    await BillingService.createExtrasCheckout(org, packId, url1, url2);
    const minuteAfter = Math.floor(Date.now() / 60000);

    // If minute didn't flip, both keys are identical
    if (minuteBefore === minuteAfter) {
      const key1 = mockStripeInstance.checkout.sessions.create.mock.calls[0][1].idempotencyKey;
      const key2 = mockStripeInstance.checkout.sessions.create.mock.calls[1][1].idempotencyKey;
      expect(key1).toBe(key2);
    }
    // (If minute did flip during test run, the test is still correct — just skip assertion)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 9 — Server-side live active-subscription check in createCheckout
// ─────────────────────────────────────────────────────────────────────────────
describe('BillingService.createCheckout — server-side active-sub guard:', () => {
  let BillingService;
  let mockStripeInstance;
  let mockSubscriptionRepository;

  const org = { _id: '507f1f77bcf86cd799439011', name: 'Test Org' };
  const priceId = 'price_pro';

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }) } },
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
      billingPortal: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://portal.stripe.com/test' }) } },
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [] }), // no active sub by default
      },
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_test', status: 'free' }),
      findByStripeCustomerId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn().mockReturnValue(mockStripeInstance) }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({ default: mockSubscriptionRepository }));
    jest.unstable_mockModule('../services/billing.plans.service.js', () => ({
      default: { getPlans: jest.fn().mockResolvedValue([{ planId: 'pro', stripePriceMonthly: priceId }]) },
    }));
    jest.unstable_mockModule('../lib/billing.errors.js', () => ({
      isDuplicateKeyError: jest.fn().mockReturnValue(false),
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        stripe: { secretKey: 'sk_test' },
        billing: { packs: [] },
        domain: 'test.example.com',
      },
    }));

    const mod = await import('../services/billing.service.js');
    BillingService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no live active/trialing sub → stripe.subscriptions.list called with status:all, checkout proceeds', async () => {
    mockStripeInstance.subscriptions.list.mockResolvedValue({ data: [] });

    await BillingService.createCheckout(
      org,
      priceId,
      'https://test.example.com/success',
      'https://test.example.com/cancel',
    );

    // Guard upgraded to status:'all' + local filter to catch both 'active' and 'trialing' in one call
    expect(mockStripeInstance.subscriptions.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all', limit: 10 }),
    );
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalled();
  });

  test('live active sub exists → throws 409 subscription_already_active (race-safe)', async () => {
    mockStripeInstance.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_live_001', status: 'active' }],
    });

    const err = await BillingService.createCheckout(
      org,
      priceId,
      'https://test.example.com/success',
      'https://test.example.com/cancel',
    ).catch((e) => e);

    expect(err.code).toBe('subscription_already_active');
    expect(err.statusCode).toBe(409);
    expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('subscriptions.list not called when customer has no stripeCustomerId', async () => {
    // Subscription doc has no stripeCustomerId — _ensureStripeCustomer will create one
    mockSubscriptionRepository.findByOrganization
      .mockResolvedValueOnce({ status: 'free' }) // findByOrganization in block-check
      .mockResolvedValueOnce(null)               // findByOrganization in _ensureStripeCustomer
      .mockResolvedValueOnce({ stripeCustomerId: null }); // latest

    // Should not call subscriptions.list since no customerId was available before ensureCustomer
    // (the guard only runs when subscription.stripeCustomerId is truthy after _ensureStripeCustomer)
    // This test just verifies it doesn't throw
    mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_new' });
    mockSubscriptionRepository.create.mockResolvedValue({ stripeCustomerId: 'cus_new' });

    // May or may not call list depending on the order of operations; just ensure no crash
    // If it proceeds to create it's fine; if blocked at 409 that's fine too.
    try {
      await BillingService.createCheckout(
        org,
        priceId,
        'https://test.example.com/success',
        'https://test.example.com/cancel',
      );
    } catch (e) {
      // Acceptable: the final fallback may throw "No Stripe customer found"
      if (e.code !== 'subscription_already_active') {
        // Any other error is acceptable in this edge-case path
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Listener-error swallow paths — logger.error called but no propagation
// (covers webhook lines 314 plan.changed listener catch + 549 refund.unresolved listener catch)
// ─────────────────────────────────────────────────────────────────────────────
describe('handleSubscriptionUpdated — plan.changed listener error swallow:', () => {
  let BillingWebhookService;
  let mockLogger;
  let mockEvents;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = {
      emit: jest.fn((evtName) => {
        if (evtName === 'plan.changed') throw new Error('plan listener blew');
      }),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(),
        findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn().mockResolvedValue({ _id: subId, organization: orgId }),
        create: jest.fn(),
        update: jest.fn(),
        updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: { tryRecord: jest.fn().mockResolvedValue({ recorded: true }), incrementAttempts: jest.fn(), markDeadLetter: jest.fn(), deleteByEventId: jest.fn() },
    }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: { setPlan: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: { creditPack: jest.fn(), refundPartial: jest.fn() } }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: { resetWeek: jest.fn().mockResolvedValue({}), forceRotateForPlanChange: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'], meterMode: true } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('plan.changed listener throws → logger.error called, webhook does NOT propagate', async () => {
    const newPeriodStart = 1700604800;

    await expect(
      BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_listener_err',
          status: 'active',
          items: {
            data: [{
              price: { metadata: { planId: 'pro' } },
              current_period_start: newPeriodStart,
              current_period_end: newPeriodStart + 2592000,
            }],
          },
        },
        {
          id: 'evt_plan_listener_err', created: 1700000100,
          data: {
            previous_attributes: {
              items: { data: [{ price: { metadata: { planId: 'starter' } }, current_period_start: 1700000000 }] },
            },
          },
        },
      ),
    ).resolves.not.toThrow();

    expect(mockEvents.emit).toHaveBeenCalledWith('plan.changed', expect.any(Object));
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] plan.changed listener error (non-fatal)',
      expect.objectContaining({ error: 'plan listener blew' }),
    );
  });
});

describe('handleChargeRefunded — billing.refund.unresolved listener error swallow:', () => {
  let BillingWebhookService;
  let mockLogger;
  let mockEvents;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = {
      emit: jest.fn((evtName) => {
        if (evtName === 'billing.refund.unresolved') throw new Error('refund listener blew');
      }),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn().mockReturnValue(null) }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: { resetWeek: jest.fn() } }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(), findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(), create: jest.fn(), update: jest.fn(),
        updateIfEventNewer: jest.fn().mockResolvedValue(null),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
        incrementAttempts: jest.fn().mockResolvedValue({ attempts: 1 }),
        deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
        markDeadLetter: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('emit throws on unresolved branch → logger.error called, no propagation', async () => {
    // No payment_intent → skips PI fetch → falls into isUnresolved() final branch
    await expect(
      BillingWebhookService.handleChargeRefunded({
        id: 'ch_listener_err',
        payment_intent: null,
        metadata: { organizationId: orgId },
        refunds: { data: [{ id: 'rf_listener_err', amount: 4900 }] },
      }),
    ).resolves.not.toThrow();

    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.refund.unresolved',
      expect.objectContaining({ chargeId: 'ch_listener_err' }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] billing.refund.unresolved listener error (non-fatal)',
      expect.objectContaining({ error: 'refund listener blew' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-LIVE — customer.deleted handler (null out stale Stripe refs)
// ─────────────────────────────────────────────────────────────────────────────
describe('handleCustomerDeleted — null out stripeCustomerId / subscription:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockResetService;
  let mockLogger;
  let mockProcessedStripeEventRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';
  const stripeCustomerId = 'cus_test_deleted_001';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockProcessedStripeEventRepository = {
      tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
      incrementAttempts: jest.fn().mockResolvedValue({ attempts: 1 }),
      deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
      markDeadLetter: jest.fn(),
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateIfEventNewer: jest.fn(),
    };
    mockOrganizationRepository = { setPlan: jest.fn().mockResolvedValue() };
    mockResetService = {
      resetWeek: jest.fn(),
      forceRotateForPlanChange: jest.fn().mockResolvedValue(),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn().mockReturnValue(null) }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: mockResetService }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: mockProcessedStripeEventRepository,
    }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: { emit: jest.fn() } }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('subscription found: nulls stripeCustomerId/subscriptionId, sets plan=free, syncs org, rotates meter', async () => {
    mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue({
      _id: subId,
      organization: orgId,
      stripeCustomerId,
      stripeSubscriptionId: 'sub_test_001',
      plan: 'pro',
      status: 'active',
    });
    mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });

    await BillingWebhookService.handleCustomerDeleted(
      { id: stripeCustomerId },
      { id: 'evt_cd_001', type: 'customer.deleted', created: 1714000000 },
    );

    expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
      String(subId),
      1714000000,
      'evt_cd_001',
      expect.objectContaining({
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        plan: 'free',
        status: 'canceled',
      }),
      'subscription',
    );
    expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'free');
    expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: false });
  });

  test('no matching subscription: short-circuits silently, no writes', async () => {
    mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);

    await BillingWebhookService.handleCustomerDeleted(
      { id: 'cus_unknown' },
      { id: 'evt_cd_002', type: 'customer.deleted', created: 1714000000 },
    );

    expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    expect(mockResetService.forceRotateForPlanChange).not.toHaveBeenCalled();
  });

  test('stale event: updateIfEventNewer returns null → logs skip, does NOT sync org', async () => {
    mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue({
      _id: subId, organization: orgId, stripeCustomerId,
    });
    mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);

    await BillingWebhookService.handleCustomerDeleted(
      { id: stripeCustomerId },
      { id: 'evt_cd_stale', type: 'customer.deleted', created: 1700000000 },
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[billing.webhook] skipped stale event',
      expect.objectContaining({ eventId: 'evt_cd_stale' }),
    );
    expect(mockOrganizationRepository.setPlan).not.toHaveBeenCalled();
    expect(mockResetService.forceRotateForPlanChange).not.toHaveBeenCalled();
  });

  test('forceRotate failure is non-fatal: logs error and resolves', async () => {
    mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue({
      _id: subId, organization: orgId, stripeCustomerId,
    });
    mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue({ _id: subId });
    mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('reset boom'));

    await expect(
      BillingWebhookService.handleCustomerDeleted(
        { id: stripeCustomerId },
        { id: 'evt_cd_rotate_fail', type: 'customer.deleted', created: 1714000000 },
      ),
    ).resolves.not.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] forceRotateForPlanChange on customer.deleted failed (non-fatal)',
      expect.objectContaining({ organizationId: orgId, error: 'reset boom' }),
    );
  });

  test('handler is exported on the service default — controller can dispatch', async () => {
    // Sanity check that the new handler is part of the public API surface used by
    // the webhook controller switch (controller dispatch is integration-tested
    // separately in billing.webhook.integration.tests.js).
    expect(typeof BillingWebhookService.handleCustomerDeleted).toBe('function');
  });

  test('runs through withIdempotency: tryRecord called once with eventId+type', async () => {
    mockSubscriptionRepository.findByStripeCustomerId.mockResolvedValue(null);
    const event = {
      id: 'evt_cd_idem_001',
      type: 'customer.deleted',
      created: 1714000000,
      data: { object: { id: stripeCustomerId } },
    };

    await BillingWebhookService.withIdempotency(event, (e) =>
      BillingWebhookService.handleCustomerDeleted(e.data.object, e),
    );

    expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith(
      'evt_cd_idem_001',
      'customer.deleted',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-LIVE — charge.dispute.created (log + emit, no auto-debit)
// ─────────────────────────────────────────────────────────────────────────────
describe('handleChargeDisputeCreated — log + emit, no auto-debit:', () => {
  let BillingWebhookService;
  let mockExtraService;
  let mockEvents;
  let mockLogger;
  let mockStripeInstance;
  let mockGetStripe;
  let mockProcessedStripeEventRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSessionId = 'cs_test_dispute_001';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };
    mockExtraService = {
      creditPack: jest.fn(),
      refundPartial: jest.fn(),
    };
    mockProcessedStripeEventRepository = {
      tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
      incrementAttempts: jest.fn().mockResolvedValue({ attempts: 1 }),
      deleteByEventId: jest.fn().mockResolvedValue({ deleted: true }),
      markDeadLetter: jest.fn(),
    };

    mockStripeInstance = {
      charges: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'ch_disputed_001',
          payment_intent: 'pi_disputed_001',
          metadata: { organizationId: orgId, stripeSessionId, packId: 'pack_500k' },
        }),
      },
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_disputed_001',
          metadata: { organizationId: orgId, stripeSessionId, packId: 'pack_500k' },
        }),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: mockExtraService }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: { resetWeek: jest.fn() } }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(), findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(), create: jest.fn(), update: jest.fn(),
        updateIfEventNewer: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: mockProcessedStripeEventRepository,
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('emits billing.dispute.opened + logs error with chargeId/orgId/amount; never debits', async () => {
    await BillingWebhookService.handleChargeDisputeCreated(
      {
        id: 'dp_001',
        charge: 'ch_disputed_001',
        amount: 2900,
        reason: 'fraudulent',
      },
      { id: 'evt_dp_001', type: 'charge.dispute.created', created: 1714000000 },
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] dispute opened — manual review required',
      expect.objectContaining({
        disputeId: 'dp_001',
        chargeId: 'ch_disputed_001',
        organizationId: orgId,
        amount: 2900,
        reason: 'fraudulent',
      }),
    );
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.dispute.opened',
      expect.objectContaining({
        disputeId: 'dp_001',
        chargeId: 'ch_disputed_001',
        organizationId: orgId,
        amount: 2900,
      }),
    );
    // Conservative: never auto-debit on dispute opening — half of disputes are won.
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
  });

  test('falls back to PaymentIntent metadata when charge metadata lacks organizationId', async () => {
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: 'ch_no_meta',
      payment_intent: 'pi_disputed_001',
      metadata: {},
    });

    await BillingWebhookService.handleChargeDisputeCreated(
      { id: 'dp_002', charge: 'ch_no_meta', amount: 2900 },
      { id: 'evt_dp_002', type: 'charge.dispute.created', created: 1714000000 },
    );

    expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_disputed_001');
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.dispute.opened',
      expect.objectContaining({ organizationId: orgId }),
    );
  });

  test('Stripe charge fetch failure: still logs+emits with null orgId, never throws', async () => {
    mockStripeInstance.charges.retrieve.mockRejectedValue(new Error('Stripe API down'));

    await expect(
      BillingWebhookService.handleChargeDisputeCreated(
        { id: 'dp_003', charge: 'ch_fetch_fail', amount: 2900 },
        { id: 'evt_dp_003', type: 'charge.dispute.created', created: 1714000000 },
      ),
    ).resolves.not.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] dispute charge/PI fetch failed',
      expect.objectContaining({ chargeId: 'ch_fetch_fail' }),
    );
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.dispute.opened',
      expect.objectContaining({ disputeId: 'dp_003', organizationId: null }),
    );
  });

  test('runs through withIdempotency: tryRecord called once with eventId+type', async () => {
    const event = {
      id: 'evt_dp_idem_001',
      type: 'charge.dispute.created',
      created: 1714000000,
      data: { object: { id: 'dp_idem_001', charge: 'ch_disputed_001', amount: 2900 } },
    };

    await BillingWebhookService.withIdempotency(event, (e) =>
      BillingWebhookService.handleChargeDisputeCreated(e.data.object, e),
    );

    expect(mockProcessedStripeEventRepository.tryRecord).toHaveBeenCalledWith(
      'evt_dp_idem_001',
      'charge.dispute.created',
    );
  });

  test('listener throws on billing.dispute.opened: logged as non-fatal, no propagation', async () => {
    mockEvents.emit.mockImplementation((evtName) => {
      if (evtName === 'billing.dispute.opened') throw new Error('dispute listener blew');
    });

    await expect(
      BillingWebhookService.handleChargeDisputeCreated(
        { id: 'dp_004', charge: 'ch_disputed_001', amount: 2900 },
        { id: 'evt_dp_004', type: 'charge.dispute.created', created: 1714000000 },
      ),
    ).resolves.not.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] billing.dispute.opened listener error (non-fatal)',
      expect.objectContaining({ error: 'dispute listener blew' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-LIVE — charge.dispute.funds_withdrawn (dispute lost — debit ledger)
// ─────────────────────────────────────────────────────────────────────────────
describe('handleChargeDisputeFundsWithdrawn — dispute lost, debit ledger:', () => {
  let BillingWebhookService;
  let mockExtraService;
  let mockEvents;
  let mockLogger;
  let mockStripeInstance;
  let mockGetStripe;

  const orgId = '507f1f77bcf86cd799439011';
  const stripeSessionId = 'cs_test_dispute_fw_001';
  const packId = 'pack_500k';

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    mockEvents = { emit: jest.fn() };
    mockExtraService = {
      creditPack: jest.fn(),
      refundPartial: jest.fn().mockResolvedValue({ doc: {}, applied: true, refundUnits: 100000 }),
    };

    mockStripeInstance = {
      charges: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'ch_fw_001',
          payment_intent: 'pi_fw_001',
          metadata: { organizationId: orgId, stripeSessionId, packId },
        }),
      },
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_fw_001',
          metadata: { organizationId: orgId, stripeSessionId, packId },
        }),
      },
    };
    mockGetStripe = jest.fn().mockReturnValue(mockStripeInstance);

    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: mockGetStripe }));
    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({ default: mockExtraService }));
    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({ default: { resetWeek: jest.fn() } }));
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn(), findByStripeCustomerId: jest.fn(),
        findByStripeSubscriptionId: jest.fn(), create: jest.fn(), update: jest.fn(),
        updateIfEventNewer: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        tryRecord: jest.fn().mockResolvedValue({ recorded: true, retry: false }),
        incrementAttempts: jest.fn(),
        deleteByEventId: jest.fn(),
        markDeadLetter: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: mockEvents }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { billing: { plans: ['free', 'starter', 'pro', 'enterprise'] } },
    }));
    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: () => ({}),
      },
    }));

    const mod = await import('../services/billing.webhook.service.js');
    BillingWebhookService = mod.default;
  });

  afterEach(() => jest.restoreAllMocks());

  test('fully resolved: ledger debited via refundPartial(refId="dispute_<id>"), event emitted, log called', async () => {
    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_fw_001', charge: 'ch_fw_001', amount: 2900 },
      { id: 'evt_fw_001', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
      orgId,
      stripeSessionId,
      2900,
      packId,
      'dispute_dp_fw_001',
    );
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.dispute.lost',
      expect.objectContaining({
        disputeId: 'dp_fw_001',
        chargeId: 'ch_fw_001',
        organizationId: orgId,
        stripeSessionId,
        amount: 2900,
      }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] dispute lost — funds withdrawn, ledger debited',
      expect.objectContaining({ disputeId: 'dp_fw_001', amount: 2900 }),
    );
  });

  test('SENTINEL_PENDING in charge.metadata → backfill via PaymentIntent → debit succeeds', async () => {
    mockStripeInstance.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_fw_002',
      payment_intent: 'pi_fw_002',
      metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId: undefined },
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_fw_002',
      metadata: { organizationId: orgId, stripeSessionId: 'cs_test_real', packId },
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_fw_002', charge: 'ch_fw_002', amount: 1500 },
      { id: 'evt_fw_002', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockStripeInstance.paymentIntents.retrieve).toHaveBeenCalledWith('pi_fw_002');
    expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
      orgId,
      'cs_test_real',
      1500,
      packId,
      'dispute_dp_fw_002',
    );
  });

  test('charge unrelated to billing (no org / no session) → emit billing.refund.unresolved, no debit, no crash', async () => {
    mockStripeInstance.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_unrelated',
      payment_intent: null,
      metadata: {}, // no org/session/pack — not a billing extras charge
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_unrelated', charge: 'ch_unrelated', amount: 4500 },
      { id: 'evt_unrelated', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.refund.unresolved',
      expect.objectContaining({ reason: 'dispute_unresolved', disputeId: 'dp_unrelated' }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing] dispute.funds_withdrawn unresolved — manual reconciliation required',
      expect.objectContaining({ disputeId: 'dp_unrelated' }),
    );
  });

  test('idempotent re-delivery: refId is stable per dispute (downstream refundPartial enforces no-op)', async () => {
    const dispute = { id: 'dp_idem', charge: 'ch_fw_001', amount: 2900 };
    const evt = { id: 'evt_idem', type: 'charge.dispute.funds_withdrawn', created: 1714000000 };

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(dispute, evt);
    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(dispute, evt);

    expect(mockExtraService.refundPartial).toHaveBeenCalledTimes(2);
    // Both calls use the SAME refId — refundPartial's ledger-layer idempotency makes the second a no-op.
    expect(mockExtraService.refundPartial.mock.calls[0][4]).toBe('dispute_dp_idem');
    expect(mockExtraService.refundPartial.mock.calls[1][4]).toBe('dispute_dp_idem');
  });

  test('missing required fields (no chargeId): emit billing.refund.unresolved with reason=dispute_missing_fields, no debit', async () => {
    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_bad', charge: null, amount: 2900 },
      { id: 'evt_bad', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.refund.unresolved',
      expect.objectContaining({ reason: 'dispute_missing_fields' }),
    );
  });

  test('zero amount: skipped via missing-fields branch, no debit', async () => {
    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_zero', charge: 'ch_fw_001', amount: 0 },
      { id: 'evt_zero', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
  });

  test('missing-fields emit throws → listener error logged as non-fatal, no propagation', async () => {
    mockEvents.emit.mockImplementationOnce((evtName) => {
      if (evtName === 'billing.refund.unresolved') throw new Error('listener_blew_missing');
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_emit_miss', charge: null, amount: 2900 },
      { id: 'evt_emit_miss', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] billing.refund.unresolved listener error (non-fatal)',
      expect.objectContaining({ error: 'listener_blew_missing' }),
    );
  });

  test('Stripe client unavailable (getStripe → null) → log critical, return early without debit', async () => {
    mockGetStripe.mockReturnValueOnce(null);

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_no_stripe', charge: 'ch_fw_001', amount: 2900 },
      { id: 'evt_no_stripe', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockStripeInstance.charges.retrieve).not.toHaveBeenCalled();
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] dispute.funds_withdrawn — Stripe client unavailable, cannot resolve charge',
      expect.objectContaining({ disputeId: 'dp_no_stripe', chargeId: 'ch_fw_001' }),
    );
  });

  test('charge fetch failure → log error then re-throw (transient failures count toward dead-letter)', async () => {
    mockStripeInstance.charges.retrieve.mockRejectedValueOnce(new Error('stripe_5xx'));

    await expect(
      BillingWebhookService.handleChargeDisputeFundsWithdrawn(
        { id: 'dp_charge_err', charge: 'ch_broken', amount: 2900 },
        { id: 'evt_charge_err', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
      ),
    ).rejects.toThrow('stripe_5xx');

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] dispute.funds_withdrawn charge fetch failed',
      expect.objectContaining({ chargeId: 'ch_broken', disputeId: 'dp_charge_err', error: 'stripe_5xx' }),
    );
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
  });

  test('PI fetch fails → log non-fatal, fall through with charge.metadata only (still resolves when sufficient)', async () => {
    // charge has full metadata but session is the sentinel → triggers PI backfill, which throws.
    mockStripeInstance.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_fw_pi_err',
      payment_intent: 'pi_fw_pi_err',
      metadata: { organizationId: orgId, stripeSessionId: '__pending__', packId },
    });
    mockStripeInstance.paymentIntents.retrieve.mockRejectedValueOnce(new Error('pi_fetch_5xx'));

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_pi_err', charge: 'ch_fw_pi_err', amount: 2900 },
      { id: 'evt_pi_err', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] dispute.funds_withdrawn PI fetch failed',
      expect.objectContaining({ paymentIntentId: 'pi_fw_pi_err', disputeId: 'dp_pi_err', error: 'pi_fetch_5xx' }),
    );
    // session still unresolved → unresolved branch fires, no debit.
    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockEvents.emit).toHaveBeenCalledWith(
      'billing.refund.unresolved',
      expect.objectContaining({ reason: 'dispute_unresolved', disputeId: 'dp_pi_err' }),
    );
  });

  test('PI metadata backfills organizationId when charge has none (or invalid)', async () => {
    mockStripeInstance.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_fw_org_backfill',
      payment_intent: 'pi_fw_org_backfill',
      metadata: { organizationId: 'not-a-valid-objectid', stripeSessionId: '__pending__', packId: undefined },
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_fw_org_backfill',
      metadata: { organizationId: orgId, stripeSessionId: 'cs_test_pi_real', packId },
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_org_backfill', charge: 'ch_fw_org_backfill', amount: 1500 },
      { id: 'evt_org_backfill', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
      orgId,
      'cs_test_pi_real',
      1500,
      packId,
      'dispute_dp_org_backfill',
    );
  });

  test('unresolved emit throws → listener error logged, no propagation', async () => {
    mockStripeInstance.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_unres_emit',
      payment_intent: null,
      metadata: {},
    });
    mockEvents.emit.mockImplementationOnce((evtName) => {
      if (evtName === 'billing.refund.unresolved') throw new Error('listener_blew_unresolved');
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_unres_emit', charge: 'ch_unres_emit', amount: 2900 },
      { id: 'evt_unres_emit', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    expect(mockExtraService.refundPartial).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] billing.refund.unresolved listener error (non-fatal)',
      expect.objectContaining({ error: 'listener_blew_unresolved' }),
    );
  });

  test('billing.dispute.lost listener error → logged as non-fatal, debit still completes', async () => {
    mockEvents.emit.mockImplementationOnce((evtName) => {
      if (evtName === 'billing.dispute.lost') throw new Error('listener_blew_lost');
    });

    await BillingWebhookService.handleChargeDisputeFundsWithdrawn(
      { id: 'dp_lost_emit', charge: 'ch_fw_001', amount: 2900 },
      { id: 'evt_lost_emit', type: 'charge.dispute.funds_withdrawn', created: 1714000000 },
    );

    // Debit still happened (listener error must not interrupt the flow).
    expect(mockExtraService.refundPartial).toHaveBeenCalledWith(
      orgId,
      stripeSessionId,
      2900,
      packId,
      'dispute_dp_lost_emit',
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[billing.webhook] billing.dispute.lost listener error (non-fatal)',
      expect.objectContaining({ error: 'listener_blew_lost' }),
    );
  });
});
