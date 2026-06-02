import { jest, describe, test, expect, beforeEach } from '@jest/globals';

describe('billing.refund.service — refundCharge:', () => {
  let RefundService;
  let mockStripe;
  let mockRefundsCreate;

  beforeEach(async () => {
    jest.resetModules();
    mockRefundsCreate = jest.fn().mockResolvedValue({ id: 're_test_123', status: 'succeeded' });
    mockStripe = { refunds: { create: mockRefundsCreate } };
    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: jest.fn().mockReturnValue(mockStripe),
    }));
    ({ default: RefundService } = await import('../services/billing.refund.service.js'));
  });

  test('initiates a full refund when amountCents omitted', async () => {
    const result = await RefundService.refundCharge('ch_test_123');
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockRefundsCreate.mock.calls[0][0];
    expect(callArgs.charge).toBe('ch_test_123');
    expect(callArgs.amount).toBeUndefined();
    expect(result.id).toBe('re_test_123');
  });

  test('uses partial amount when amountCents provided', async () => {
    await RefundService.refundCharge('ch_test_456', 5000);
    expect(mockRefundsCreate).toHaveBeenCalledWith(expect.objectContaining({
      charge: 'ch_test_456',
      amount: 5000,
    }), expect.any(Object));
  });

  test('passes deterministic idempotency key derived from charge+amount', async () => {
    await RefundService.refundCharge('ch_idem_test', 1000);
    const idemArg = mockRefundsCreate.mock.calls[0][1];
    expect(idemArg).toBeDefined();
    expect(idemArg.idempotencyKey).toBeDefined();
    // Same charge+amount → same key (deterministic)
    await RefundService.refundCharge('ch_idem_test', 1000);
    const idemArg2 = mockRefundsCreate.mock.calls[1][1];
    expect(idemArg2.idempotencyKey).toBe(idemArg.idempotencyKey);
  });

  test('passes reason when provided', async () => {
    await RefundService.refundCharge('ch_test', undefined, { reason: 'requested_by_customer' });
    expect(mockRefundsCreate).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'requested_by_customer',
    }), expect.any(Object));
  });

  test('throws when stripeChargeId is empty', async () => {
    await expect(RefundService.refundCharge('')).rejects.toThrow();
  });

  test('throws when amountCents is 0 or negative', async () => {
    await expect(RefundService.refundCharge('ch_x', 0)).rejects.toThrow();
    await expect(RefundService.refundCharge('ch_x', -100)).rejects.toThrow();
  });
});
