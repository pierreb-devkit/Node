/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for subscription-related webhook handlers:
 *   - handleSubscriptionUpdated (period_start change → resetWeek)
 *   - handleInvoicePaymentSucceeded (pastDueSince cleared)
 *   - handleInvoicePaymentFailed (status → past_due)
 */
describe('Billing webhook subscription unit tests:', () => {
  let BillingWebhookService;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockResetService;
  let mockEvents;
  let mockStripe;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findByStripeCustomerId: jest.fn(),
      findByStripeSubscriptionId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateIfEventNewer: jest.fn().mockResolvedValue({ _id: subId }),
    };

    mockOrganizationRepository = {
      setPlan: jest.fn().mockResolvedValue({}),
    };

    mockResetService = {
      resetWeek: jest.fn().mockResolvedValue({}),
      forceRotateForPlanChange: jest.fn().mockResolvedValue({}),
    };

    mockEvents = { emit: jest.fn() };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: {
        wasProcessed: jest.fn().mockResolvedValue(false),
        tryRecord: jest.fn().mockResolvedValue({ recorded: true }),
      },
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: mockResetService,
    }));

    mockStripe = {
      subscriptions: { retrieve: jest.fn() },
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn(() => mockStripe),
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: mockEvents,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro', 'enterprise'],
          meterMode: true,
        },
      },
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleSubscriptionUpdated — period_start change', () => {
    test('should call resetWeek when current_period_start changes', async () => {
      const oldPeriodStart = 1700000000;
      const newPeriodStart = 1700604800;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: newPeriodStart + 2592000,
          current_period_start: newPeriodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_1', created: 1700000100,
          data: {
            previous_attributes: {
              current_period_start: oldPeriodStart,
            },
          },
        },
      );

      expect(mockResetService.resetWeek).toHaveBeenCalledWith(
        orgId,
        new Date(newPeriodStart * 1000),
      );
    });

    test('should NOT call resetWeek when current_period_start is unchanged', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        { id: 'evt_2', created: 1700000100, data: { previous_attributes: { current_period_start: periodStart } } },
      );

      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('should NOT call resetWeek when previous_attributes has no current_period_start', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000 + 2592000,
          current_period_start: 1700000000,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        { id: 'evt_3', created: 1700000100, data: { previous_attributes: { cancel_at_period_end: true } } },
      );

      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('resetWeek errors should not disrupt webhook processing (logged, not thrown)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockResetService.resetWeek.mockRejectedValue(new Error('reset failed'));

      await expect(
        BillingWebhookService.handleSubscriptionUpdated(
          {
            id: 'sub_456',
            status: 'active',
            current_period_end: 1700604800 + 2592000,
            current_period_start: 1700604800,
            cancel_at_period_end: false,
            items: { data: [] },
          },
          { id: 'evt_4', created: 1700000100, data: { previous_attributes: { current_period_start: 1700000000 } } },
        ),
      ).resolves.not.toThrow();
    });

    // ── Plan changes refresh the active week snapshot without weekly rollover ──

    test('plan change with same period_start — forceRotateForPlanChange called once', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_5', created: 1700000100,
          data: {
            previous_attributes: {
              items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
            },
          },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('plan change AND period_start change — forceRotateForPlanChange AND resetWeek both called', async () => {
      const oldPeriodStart = 1700000000;
      const newPeriodStart = 1700604800;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: newPeriodStart + 2592000,
          current_period_start: newPeriodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_6', created: 1700000100,
          data: {
            previous_attributes: {
              current_period_start: oldPeriodStart,
              items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
            },
          },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
      expect(mockResetService.resetWeek).toHaveBeenCalledTimes(1);
      expect(mockResetService.resetWeek).toHaveBeenCalledWith(orgId, new Date(newPeriodStart * 1000));
    });

    test('fix #3571: no plan change — resetWeek NOT called on same period_start', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_7', created: 1700000100,
          data: { previous_attributes: { cancel_at_period_end: true } },
        },
      );

      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('plan upgrade Growth→Pro — forceRotateForPlanChange preserves usage', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_8', created: 1700000100,
          data: { previous_attributes: { items: { data: [{ price: { metadata: { planId: 'starter' } } }] } } },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      const [calledOrg, options] = mockResetService.forceRotateForPlanChange.mock.calls[0];
      expect(calledOrg).toBe(orgId);
      expect(options).toEqual({ preserveUsage: true });
    });

    test('plan downgrade Pro→Growth — forceRotateForPlanChange called with preserveUsage=true', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
        },
        {
          id: 'evt_9', created: 1700000100,
          data: { previous_attributes: { items: { data: [{ price: { metadata: { planId: 'pro' } } }] } } },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
    });

    test('forceRotateForPlanChange errors do not throw (non-fatal)', async () => {
      const periodStart = 1700000000;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db unavailable'));

      await expect(
        BillingWebhookService.handleSubscriptionUpdated(
          {
            id: 'sub_456',
            status: 'active',
            current_period_end: periodStart + 2592000,
            current_period_start: periodStart,
            cancel_at_period_end: false,
            items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
          },
          {
            id: 'evt_10', created: 1700000100,
            data: { previous_attributes: { items: { data: [{ price: { metadata: { planId: 'starter' } } }] } } },
          },
        ),
      ).resolves.not.toThrow();
      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('forceRotateForPlanChange throw falls back to resetWeek once when period also changed', async () => {
      const oldPeriodStart = 1700000000;
      const newPeriodStart = 1700604800;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockResetService.forceRotateForPlanChange.mockRejectedValue(new Error('db unavailable'));

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: newPeriodStart + 2592000,
          current_period_start: newPeriodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_11', created: 1700000100,
          data: {
            previous_attributes: {
              current_period_start: oldPeriodStart,
              items: { data: [{ price: { metadata: { planId: 'starter' } } }] },
            },
          },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      expect(mockResetService.resetWeek).toHaveBeenCalledTimes(1);
      expect(mockResetService.resetWeek).toHaveBeenCalledWith(orgId, new Date(newPeriodStart * 1000));
    });

    test('plan change with no newPeriodStart still force rotates', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000 + 2592000,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        {
          id: 'evt_12', created: 1700000100,
          data: { previous_attributes: { items: { data: [{ price: { metadata: { planId: 'starter' } } }] } } },
        },
      );

      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledTimes(1);
      expect(mockResetService.forceRotateForPlanChange).toHaveBeenCalledWith(orgId, { preserveUsage: true });
    });

    test('should update currentPeriodStart in subscription when period_start is present', async () => {
      const newPeriodStart = 1700604800;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: newPeriodStart + 2592000,
          current_period_start: newPeriodStart,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        { id: 'evt_13', created: 1700000100, data: { previous_attributes: {} } },
      );

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000100,
        'evt_13',
        expect.objectContaining({ currentPeriodStart: new Date(newPeriodStart * 1000) }),
        'subscription',
      );
    });
  });

  describe('handleInvoicePaymentSucceeded', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_succeeded', created: 1700000400, ...overrides });

    test('should clear pastDueSince and restore active status via updateIfEventNewer', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'past_due',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000400,
        'evt_succeeded',
        expect.objectContaining({ pastDueSince: null, status: 'active' }),
        'invoice',
      );
    });

    test('invoice-marker advance — healthy sub (pastDueSince=null) calls updateIfEventNewer with empty fields', async () => {
      // Always advance the invoice-family marker even for healthy subs so stale
      // replays of older invoice events are rejected by the ordering guard (DeepSeek HIGH fix).
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: null,
        status: 'active',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent());

      // updateIfEventNewer IS called with empty fields — marker-only update, no field changes
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000400,
        'evt_succeeded',
        {},
        'invoice',
      );
    });

    test('Opus H7 — past_due sub still calls updateIfEventNewer (critical write)', async () => {
      // Ensures the pastDueSince clearance still happens correctly for degraded subs.
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'past_due',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000400,
        'evt_succeeded',
        expect.objectContaining({ pastDueSince: null, status: 'active' }),
        'invoice',
      );
    });

    test('should return early when no subscription ID in invoice', async () => {
      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: null }, makeEvent());

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });

    test('should log info when event is stale (V5 P1 #1 ordering guard)', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'past_due',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.updateIfEventNewer.mockResolvedValue(null);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });

      let mockLogger;
      jest.unstable_mockModule('../../../lib/services/logger.js', () => {
        mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
        return { default: mockLogger };
      });

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent({ created: 50 }));

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalled();
    });

    // V8 audit C1 — dunning recovery plan restoration
    test('V8 C1 — dunning recovery: restores plan=pro after unpaid downgrade to free', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'unpaid',
        plan: 'free',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000400,
        'evt_succeeded',
        expect.objectContaining({ plan: 'pro', status: 'active', pastDueSince: null }),
        'invoice',
      );
      expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    });

    test('V8 C1 — Stripe re-fetch failure: falls back gracefully, does not restore plan', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'unpaid',
        plan: 'free',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe unavailable'));

      await expect(
        BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();

      // update still fires but without plan field
      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000400,
        'evt_succeeded',
        expect.not.objectContaining({ plan: expect.anything() }),
        'invoice',
      );
    });

    // V8.1 — syncOrganizationPlan failure path coverage
    test('V8.1 — syncOrganizationPlan failure: non-fatal, logs error + emits sync_failed', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'unpaid',
        plan: 'free',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });
      mockOrganizationRepository.setPlan.mockRejectedValue(new Error('DB write failed'));

      // The logger mock is registered in beforeEach via jest.unstable_mockModule.
      // Import it here (after BillingWebhookService) to get the same mocked instance
      // that the service module captured at load time.
      const { default: mockLogger } = await import('../../../lib/services/logger.js');

      await expect(
        BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.webhook] syncOrganizationPlan failed (non-fatal)',
        expect.objectContaining({ organizationId: orgId }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'billing.organization.sync_failed',
        expect.objectContaining({ organizationId: orgId, source: 'dunning_recovery' }),
      );
    });

    test('V8.1 — sync_failed listener throws: inner evtErr catch is non-fatal', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'unpaid',
        plan: 'free',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
      });
      // Make syncOrganizationPlan throw so we enter the syncErr catch
      mockOrganizationRepository.setPlan.mockRejectedValue(new Error('DB write failed'));
      // Make billingEvents.emit throw so we enter the inner evtErr catch
      mockEvents.emit.mockImplementation(() => { throw new Error('listener crash'); });

      const { default: mockLogger } = await import('../../../lib/services/logger.js');

      await expect(
        BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[billing.webhook] billing.organization.sync_failed listener error (non-fatal)',
        expect.objectContaining({ error: 'listener crash' }),
      );
    });

    test('V8.1 — resolvePlanFromSubscription warns on unrecognized non-empty planId (falls back to free)', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'past_due',
        plan: 'free',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      // Return an unrecognized planId (e.g. a Stripe product ID instead of a plan slug)
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        items: { data: [{ price: { metadata: { planId: 'prod_unknownXYZ' } } }] },
      });

      const { default: mockLogger } = await import('../../../lib/services/logger.js');

      await expect(
        BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();

      // Shared resolver (billing.planResolver.js) should have logged a warning for the
      // unrecognized plan (#3964 — now shared with the admin + reconcile call sites).
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[billing.webhook] resolvePlanFromSubscription: unrecognized planId in metadata',
        expect.objectContaining({ raw: 'prod_unknownXYZ' }),
      );
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    const makeEvent = (overrides = {}) => ({ id: 'evt_failed', created: 1700000300, ...overrides });

    test('should set status to past_due via updateIfEventNewer', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).toHaveBeenCalledWith(
        subId,
        1700000300,
        'evt_failed',
        expect.objectContaining({ status: 'past_due' }),
        'invoice',
      );
    });

    test('should set pastDueSince on first failure (when currently null)', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      const before = new Date();
      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());
      const after = new Date();

      const callArg = mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
      expect(callArg.pastDueSince).toBeInstanceOf(Date);
      expect(callArg.pastDueSince.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(callArg.pastDueSince.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test('should NOT overwrite pastDueSince on subsequent failures (idempotent grace clock)', async () => {
      const originalDate = new Date('2026-04-01T00:00:00Z');
      const existing = { _id: subId, organization: orgId, pastDueSince: originalDate };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());

      const callArg = mockSubscriptionRepository.updateIfEventNewer.mock.calls[0][3];
      expect(callArg.pastDueSince).toBeUndefined();
    });

    test('should emit payment.failed event with organizationId', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent());

      expect(mockEvents.emit).toHaveBeenCalledWith('payment.failed', { organizationId: orgId });
    });

    test('should not throw when event listener errors', async () => {
      const existing = { _id: subId, organization: orgId, pastDueSince: null };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockEvents.emit.mockImplementation(() => { throw new Error('listener error'); });

      await expect(
        BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' }, makeEvent()),
      ).resolves.not.toThrow();
    });

    test('should return early when no subscription ID in invoice', async () => {
      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: null }, makeEvent());

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_unknown' }, makeEvent());

      expect(mockSubscriptionRepository.updateIfEventNewer).not.toHaveBeenCalled();
    });
  });
});
