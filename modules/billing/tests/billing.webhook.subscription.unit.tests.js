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
  let mockOrganizationModel;
  let mockResetService;
  let mockEvents;

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
    };

    mockOrganizationModel = {
      findByIdAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    mockResetService = {
      resetWeek: jest.fn().mockResolvedValue({}),
    };

    mockEvents = { emit: jest.fn() };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.processedStripeEvent.repository.js', () => ({
      default: { tryRecord: jest.fn().mockResolvedValue({ recorded: true }) },
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: { creditPack: jest.fn(), refundPartial: jest.fn() },
    }));

    jest.unstable_mockModule('../services/billing.reset.service.js', () => ({
      default: mockResetService,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: mockEvents,
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
        model: (name) => {
          if (name === 'Organization') return mockOrganizationModel;
          return {};
        },
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
      mockSubscriptionRepository.update.mockResolvedValue({});

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
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: periodStart + 2592000,
          current_period_start: periodStart,
          cancel_at_period_end: false,
          items: { data: [{ price: { metadata: { planId: 'pro' } } }] },
        },
        { data: { previous_attributes: {} } },
      );

      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('should NOT call resetWeek when previous_attributes has no current_period_start', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: 1700000000 + 2592000,
          current_period_start: 1700000000,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        { data: { previous_attributes: { cancel_at_period_end: true } } },
      );

      expect(mockResetService.resetWeek).not.toHaveBeenCalled();
    });

    test('resetWeek errors should not disrupt webhook processing (swallowed)', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});
      mockResetService.resetWeek.mockRejectedValue(new Error('reset failed'));

      // Should NOT throw
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
          { data: { previous_attributes: { current_period_start: 1700000000 } } },
        ),
      ).resolves.not.toThrow();
    });

    test('should update currentPeriodStart in subscription when period_start is present', async () => {
      const newPeriodStart = 1700604800;
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleSubscriptionUpdated(
        {
          id: 'sub_456',
          status: 'active',
          current_period_end: newPeriodStart + 2592000,
          current_period_start: newPeriodStart,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        { data: { previous_attributes: {} } },
      );

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPeriodStart: new Date(newPeriodStart * 1000),
        }),
      );
    });
  });

  describe('handleInvoicePaymentSucceeded', () => {
    test('should clear pastDueSince and restore active status when subscription is past_due', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: new Date('2026-04-01'),
        status: 'past_due',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, pastDueSince: null, status: 'active' }),
      );
    });

    test('should NOT update when pastDueSince is null (routine invoice)', async () => {
      const existing = {
        _id: subId,
        organization: orgId,
        pastDueSince: null,
        status: 'active',
      };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_456' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });

    test('should return early when no subscription ID in invoice', async () => {
      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: null });

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    test('should return early when subscription not found', async () => {
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(null);

      await BillingWebhookService.handleInvoicePaymentSucceeded({ subscription: 'sub_unknown' });

      expect(mockSubscriptionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    test('should set status to past_due', async () => {
      const existing = { _id: subId, organization: orgId };
      mockSubscriptionRepository.findByStripeSubscriptionId.mockResolvedValue(existing);
      mockSubscriptionRepository.update.mockResolvedValue({});

      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: 'sub_456' });

      expect(mockSubscriptionRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ _id: subId, status: 'past_due' }),
      );
    });

    test('should return early when no subscription ID in invoice', async () => {
      await BillingWebhookService.handleInvoicePaymentFailed({ subscription: null });

      expect(mockSubscriptionRepository.findByStripeSubscriptionId).not.toHaveBeenCalled();
    });
  });
});
