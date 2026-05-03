/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for admin refund logic (inlined in billing.admin.controller.js after
 * billing.refund.service.js was dropped in PR2 simplification).
 * Validates that the controller correctly calls stripe.refunds.create with the
 * right params and idempotency key, and handles error cases properly.
 */
describe('Admin refund controller unit tests:', () => {
  let adminRefundCharge;
  let mockStripeInstance;
  let mockGetStripe;
  let mockResponses;

  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };

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

    mockResponses = {
      success: jest.fn(() => jest.fn()),
      error: jest.fn(() => jest.fn()),
    };

    jest.unstable_mockModule('../lib/stripe.js', () => ({
      default: mockGetStripe,
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: mockResponses,
    }));

    const mod = await import('../controllers/billing.admin.controller.js');
    adminRefundCharge = mod.default.adminRefundCharge;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should call stripe.refunds.create with charge and default reason', async () => {
    const req = { body: { chargeId: 'ch_test_xyz' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'requested_by_customer' },
      { idempotencyKey: 'refund_ch_test_xyz_full' },
    );
    expect(mockResponses.success).toHaveBeenCalledWith(res, 'billing refund created');
  });

  test('should include amount when amountCents is provided', async () => {
    const req = { body: { chargeId: 'ch_test_xyz', amountCents: 2000 } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'requested_by_customer', amount: 2000 },
      { idempotencyKey: 'refund_ch_test_xyz_2000' },
    );
  });

  test('should forward an explicit reason when provided', async () => {
    const req = { body: { chargeId: 'ch_test_xyz', amountCents: 2000, reason: 'duplicate' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'duplicate', amount: 2000 },
      { idempotencyKey: 'refund_ch_test_xyz_2000' },
    );
  });

  test('idempotency key is "refund_{chargeId}_full" for full refund', async () => {
    const req = { body: { chargeId: 'ch_abc' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    const call = mockStripeInstance.refunds.create.mock.calls[0];
    expect(call[1].idempotencyKey).toBe('refund_ch_abc_full');
  });

  test('idempotency key is "refund_{chargeId}_{amountCents}" for partial refund', async () => {
    const req = { body: { chargeId: 'ch_abc', amountCents: 500 } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    const call = mockStripeInstance.refunds.create.mock.calls[0];
    expect(call[1].idempotencyKey).toBe('refund_ch_abc_500');
  });

  test('should return 502 when Stripe is not configured', async () => {
    mockGetStripe.mockReturnValue(null);
    const req = { body: { chargeId: 'ch_test' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 502, 'Bad Gateway', 'Failed to refund charge');
  });

  test('should return 422 for empty chargeId', async () => {
    const req = { body: { chargeId: '' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('should return 422 for non-string chargeId', async () => {
    const req = { body: { chargeId: null } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('should return 422 for zero amountCents', async () => {
    const req = { body: { chargeId: 'ch_test', amountCents: 0 } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('should return 422 for negative amountCents', async () => {
    const req = { body: { chargeId: 'ch_test', amountCents: -100 } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
  });

  test('should return 422 for non-integer amountCents', async () => {
    const req = { body: { chargeId: 'ch_test', amountCents: 9.99 } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
  });

  test('should succeed with undefined amountCents (full refund)', async () => {
    const req = { body: { chargeId: 'ch_test', amountCents: undefined } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalled();
    expect(mockResponses.success).toHaveBeenCalled();
  });
});
