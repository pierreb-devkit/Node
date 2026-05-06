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

  test('should call stripe.refunds.create with charge, default reason and stable idempotency key', async () => {
    const req = { body: { chargeId: 'ch_test_xyz', refundRequestId: 'req-stable-xyz00' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'requested_by_customer' },
      { idempotencyKey: 'refund_admin_req-stable-xyz00' },
    );
    expect(mockResponses.success).toHaveBeenCalledWith(res, 'billing refund created');
  });

  test('should include amount when amountCents is provided', async () => {
    const req = { body: { chargeId: 'ch_test_xyz', amountCents: 2000, refundRequestId: 'req-stable-xyz01' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'requested_by_customer', amount: 2000 },
      { idempotencyKey: 'refund_admin_req-stable-xyz01' },
    );
  });

  test('should forward an explicit reason when provided', async () => {
    const req = { body: { chargeId: 'ch_test_xyz', amountCents: 2000, reason: 'duplicate', refundRequestId: 'req-stable-xyz02' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_xyz', reason: 'duplicate', amount: 2000 },
      { idempotencyKey: 'refund_admin_req-stable-xyz02' },
    );
  });

  test('missing refundRequestId returns 422 (BREAKING — required field)', async () => {
    const req = { body: { chargeId: 'ch_abc' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('refundRequestId shorter than 8 chars returns 422', async () => {
    const req = { body: { chargeId: 'ch_abc', amountCents: 500, refundRequestId: 'short' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to refund charge');
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  test('refundRequestId generates stable "refund_admin_{id}" key (double-click protection)', async () => {
    const req = { body: { chargeId: 'ch_abc', amountCents: 500, refundRequestId: 'req-stable12345' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    const call = mockStripeInstance.refunds.create.mock.calls[0];
    expect(call[1].idempotencyKey).toBe('refund_admin_req-stable12345');
  });

  test('two calls with same refundRequestId use identical idempotency key', async () => {
    const body = { chargeId: 'ch_dup', amountCents: 1000, refundRequestId: 'req-dup12345' };

    await adminRefundCharge({ body }, makeRes());
    await adminRefundCharge({ body }, makeRes());

    const calls = mockStripeInstance.refunds.create.mock.calls;
    expect(calls[0][1].idempotencyKey).toBe('refund_admin_req-dup12345');
    expect(calls[1][1].idempotencyKey).toBe('refund_admin_req-dup12345');
  });

  test('should return 502 when Stripe is not configured', async () => {
    mockGetStripe.mockReturnValue(null);
    const req = { body: { chargeId: 'ch_test', refundRequestId: 'req-no-stripe0' } };
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
    const req = { body: { chargeId: 'ch_test', amountCents: undefined, refundRequestId: 'req-full-test0' } };
    const res = makeRes();

    await adminRefundCharge(req, res);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalled();
    expect(mockResponses.success).toHaveBeenCalled();
  });
});

describe('adminBumpPlan controller unit tests:', () => {
  let adminBumpPlan;
  let mockSubscriptionRepository;
  let mockOrganizationRepository;
  let mockLogger;
  let mockResponses;

  const orgId = '507f1f77bcf86cd799439011';
  const subId = '607f1f77bcf86cd799439022';
  const adminId = '707f1f77bcf86cd799439033';

  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn().mockResolvedValue({ _id: subId, plan: 'free', organization: orgId }),
      adminUpdatePlanOnly: jest.fn().mockResolvedValue({ _id: subId, plan: 'pro' }),
    };

    mockOrganizationRepository = {
      setPlan: jest.fn().mockResolvedValue({}),
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    mockResponses = {
      success: jest.fn(() => jest.fn()),
      error: jest.fn(() => jest.fn()),
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: mockOrganizationRepository,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: mockResponses,
    }));

    // Stripe not needed for adminBumpPlan but imported at module level
    jest.unstable_mockModule('../lib/stripe.js', () => ({ default: jest.fn(() => null) }));

    const mod = await import('../controllers/billing.admin.controller.js');
    adminBumpPlan = mod.default.adminBumpPlan;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns 422 when req.user._id is missing', async () => {
    const req = { body: { orgId, planId: 'pro' }, user: {} };
    const res = makeRes();

    await adminBumpPlan(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to bump plan');
    expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
  });

  test('returns 404 when no subscription found for org', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
    const req = { body: { orgId, planId: 'pro' }, user: { _id: adminId } };
    const res = makeRes();

    await adminBumpPlan(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 404, 'Not Found', 'Subscription not found for organization');
    expect(mockSubscriptionRepository.adminUpdatePlanOnly).not.toHaveBeenCalled();
  });

  test('returns 200 on happy path', async () => {
    const req = { body: { orgId, planId: 'pro' }, user: { _id: adminId } };
    const res = makeRes();

    await adminBumpPlan(req, res);

    expect(mockSubscriptionRepository.adminUpdatePlanOnly).toHaveBeenCalledWith(subId, 'pro', adminId);
    expect(mockOrganizationRepository.setPlan).toHaveBeenCalledWith(orgId, 'pro');
    expect(mockResponses.success).toHaveBeenCalledWith(res, 'subscription plan bumped');
  });

  test('returns 422 on Mongoose ValidationError', async () => {
    const validationErr = new Error('plan is invalid');
    validationErr.name = 'ValidationError';
    mockSubscriptionRepository.adminUpdatePlanOnly.mockRejectedValue(validationErr);
    const req = { body: { orgId, planId: 'pro' }, user: { _id: adminId } };
    const res = makeRes();

    await adminBumpPlan(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to bump plan');
  });

  test('returns 500 on unexpected error', async () => {
    mockSubscriptionRepository.adminUpdatePlanOnly.mockRejectedValue(new Error('db timeout'));
    const req = { body: { orgId, planId: 'pro' }, user: { _id: adminId } };
    const res = makeRes();

    await adminBumpPlan(req, res);

    expect(mockResponses.error).toHaveBeenCalledWith(res, 500, 'Internal Server Error', 'Failed to bump plan');
  });
});
