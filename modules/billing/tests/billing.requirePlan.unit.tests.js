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
    mockFindByOrganization.mockResolvedValue({ plan: 'pro' });

    const middleware = requirePlan('pro');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should call next when subscription plan is in multiple allowed plans', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'starter' });

    const middleware = requirePlan('starter', 'pro', 'enterprise');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should return 403 when subscription plan does not match', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'free' });

    const middleware = requirePlan('pro', 'enterprise');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
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
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
    expect(mockFindByOrganization).not.toHaveBeenCalled();
  });
});
