/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockFindByOrganization = jest.fn();
jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
  default: { findByOrganization: mockFindByOrganization },
}));

const { default: requirePlan } = await import('../middlewares/billing.requirePlan.js');

/**
 * Unit tests for the requirePlan middleware.
 */
describe('requirePlan middleware unit tests:', () => {
  const fakeOrgId = new mongoose.Types.ObjectId();

  /**
   * @desc Build a minimal Express-like req object
   * @param {Object} overrides - Properties to merge onto the request
   * @returns {Object} mock request
   */
  function mockReq(overrides = {}) {
    return {
      organization: { _id: fakeOrgId, name: 'Test Org' },
      ...overrides,
    };
  }

  /**
   * @desc Build a minimal Express-like res object with spies
   * @returns {Object} mock response
   */
  function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should call next when subscription plan matches the required plan', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });

    const middleware = requirePlan('pro');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should call next when subscription plan is in multiple allowed plans', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'starter', status: 'active' });

    const middleware = requirePlan('starter', 'pro', 'enterprise');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should return 403 when subscription plan does not match', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });

    const middleware = requirePlan('pro', 'enterprise');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Forbidden', errorCode: 'PLAN_REQUIRED' }),
    );
  });

  test('should default to free plan when no subscription exists', async () => {
    mockFindByOrganization.mockResolvedValue(null);

    const middleware = requirePlan('free');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should return 403 when no subscription exists and free is not allowed', async () => {
    mockFindByOrganization.mockResolvedValue(null);

    const middleware = requirePlan('pro');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('should return 403 when organization is missing from request', async () => {
    const middleware = requirePlan('pro');
    const req = mockReq({ organization: undefined });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Forbidden', errorCode: 'ORG_CONTEXT_REQUIRED' }),
    );
    expect(mockFindByOrganization).not.toHaveBeenCalled();
  });
});

describe('requirePlan — subscription.status gating:', () => {
  const fakeOrgId = new mongoose.Types.ObjectId();

  function mockReq(overrides = {}) {
    return {
      organization: { _id: fakeOrgId, name: 'Test Org' },
      ...overrides,
    };
  }

  function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('treats a canceled growth subscription as free (denies access)', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'growth', status: 'canceled' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('growth', 'pro')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.currentPlan).toBe('free');
  });

  test('treats a past_due growth subscription as free (denies access)', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'growth', status: 'past_due' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('growth')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.currentPlan).toBe('free');
  });

  test('treats unpaid subscription as free (denies access)', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'unpaid' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('pro')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.currentPlan).toBe('free');
  });

  test('treats incomplete subscription as free (denies access)', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'incomplete' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('pro')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.currentPlan).toBe('free');
  });

  test('passes an active growth subscription', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'growth', status: 'active' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('growth')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes a trialing pro subscription', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'trialing' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('pro')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('requirePlan — response shape (top-level errorCode):', () => {
  const fakeOrgId = new mongoose.Types.ObjectId();

  function mockReq(overrides = {}) {
    return {
      organization: { _id: fakeOrgId, name: 'Test Org' },
      ...overrides,
    };
  }

  function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns top-level errorCode, requiredPlans, currentPlan on PLAN_REQUIRED', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('growth', 'pro')(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe('PLAN_REQUIRED');
    expect(body.requiredPlans).toEqual(['growth', 'pro']);
    expect(body.currentPlan).toBe('free');
    expect(body.type).toBe('error');
    expect(body.message).toBe('Forbidden');
    expect(body.code).toBe(403);
    expect(body.status).toBe(403);
  });

  test('returns ORG_CONTEXT_REQUIRED errorCode when req.organization is absent', async () => {
    const req = mockReq({ organization: undefined });
    const res = mockRes();
    const next = jest.fn();

    await requirePlan('growth')(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe('ORG_CONTEXT_REQUIRED');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(body.type).toBe('error');
  });
});
