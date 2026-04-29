/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.refund.service.js
 */
describe('BillingRefundService unit tests:', () => {
  let BillingRefundService;
  let mockStripeInstance;
  let mockGetStripe;

  beforeEach(async () => {
    jest.resetModules();

    mockStripeInstance = {
      refunds: {
        create: jest.fn().mockResolvedValue({
          id: 're_test_abc',
          amount: 4900,
          status: 'succeeded',
        }),
      },
    };

    mockGetStripe = jest.fn(() => mockStripeInstance);

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: mockGetStripe,
    }));

    const mod = await import('../services/billing.refund.service.js');
    BillingRefundService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('refundCharge', () => {
    test('should call stripe.refunds.create with charge and reason', async () => {
      const result = await BillingRefundService.refundCharge('ch_test_xyz');

      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { charge: 'ch_test_xyz', reason: 'requested_by_customer' },
        { idempotencyKey: 'refund_ch_test_xyz_full' },
      );
      expect(result.id).toBe('re_test_abc');
    });

    test('should include amount when amountCents is provided', async () => {
      await BillingRefundService.refundCharge('ch_test_xyz', 2000);

      expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
        { charge: 'ch_test_xyz', reason: 'requested_by_customer', amount: 2000 },
        { idempotencyKey: 'refund_ch_test_xyz_2000' },
      );
    });

    test('idempotency key is "refund_{chargeId}_full" for full refund', async () => {
      await BillingRefundService.refundCharge('ch_abc');

      const call = mockStripeInstance.refunds.create.mock.calls[0];
      expect(call[1].idempotencyKey).toBe('refund_ch_abc_full');
    });

    test('idempotency key is "refund_{chargeId}_{amountCents}" for partial refund', async () => {
      await BillingRefundService.refundCharge('ch_abc', 500);

      const call = mockStripeInstance.refunds.create.mock.calls[0];
      expect(call[1].idempotencyKey).toBe('refund_ch_abc_500');
    });

    test('different amountCents produces different idempotency keys', async () => {
      await BillingRefundService.refundCharge('ch_same', 1000);
      await BillingRefundService.refundCharge('ch_same', 2000);

      const keys = mockStripeInstance.refunds.create.mock.calls.map((c) => c[1].idempotencyKey);
      expect(keys[0]).toBe('refund_ch_same_1000');
      expect(keys[1]).toBe('refund_ch_same_2000');
    });

    test('should throw when Stripe is not configured', async () => {
      mockGetStripe.mockReturnValue(null);

      await expect(BillingRefundService.refundCharge('ch_test')).rejects.toThrow('Stripe is not configured');
    });

    test('should throw for empty stripeChargeId', async () => {
      await expect(BillingRefundService.refundCharge('')).rejects.toThrow(
        'invalid argument: stripeChargeId must be a non-empty string',
      );
    });

    test('should throw for non-string stripeChargeId', async () => {
      await expect(BillingRefundService.refundCharge(null)).rejects.toThrow(
        'invalid argument: stripeChargeId must be a non-empty string',
      );
    });

    test('should throw for zero amountCents', async () => {
      await expect(BillingRefundService.refundCharge('ch_test', 0)).rejects.toThrow(
        'invalid argument: amountCents must be a positive integer',
      );
    });

    test('should throw for negative amountCents', async () => {
      await expect(BillingRefundService.refundCharge('ch_test', -100)).rejects.toThrow(
        'invalid argument: amountCents must be a positive integer',
      );
    });

    test('should throw for non-integer amountCents', async () => {
      await expect(BillingRefundService.refundCharge('ch_test', 9.99)).rejects.toThrow(
        'invalid argument: amountCents must be a positive integer',
      );
    });

    test('should accept undefined amountCents (full refund)', async () => {
      await expect(BillingRefundService.refundCharge('ch_test', undefined)).resolves.toBeDefined();
    });
  });
});
