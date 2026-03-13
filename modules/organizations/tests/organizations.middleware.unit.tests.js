/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockGet = jest.fn();
jest.unstable_mockModule('../services/organizations.crud.service.js', () => ({
  default: { get: mockGet },
}));

const mockFindByUserAndOrganization = jest.fn();
jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: { findByUserAndOrganization: mockFindByUserAndOrganization },
}));

const { default: organizationsMiddleware } = await import('../middleware/organizations.middleware.js');
const { resolveOrganization } = organizationsMiddleware;

/**
 * Unit tests for the resolveOrganization middleware.
 */
describe('resolveOrganization middleware unit tests:', () => {
  const fakeOrgId = new mongoose.Types.ObjectId();
  const fakeUserId = new mongoose.Types.ObjectId();

  const fakeOrganization = { _id: fakeOrgId, name: 'Test Org', slug: 'test-org' };
  const fakeMembership = { _id: new mongoose.Types.ObjectId(), userId: fakeUserId, organizationId: fakeOrgId, role: 'member' };

  /**
   * @desc Build a minimal Express-like req object
   * @param {Object} overrides - Properties to merge onto the request
   * @returns {Object} mock request
   */
  function mockReq(overrides = {}) {
    return {
      params: {},
      user: { _id: fakeUserId, roles: ['user'] },
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

  test('should call next without setting req.organization when no organizationId is present', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toBeUndefined();
    expect(req.membership).toBeUndefined();
  });

  test('should return 404 when organization is not found', async () => {
    mockGet.mockResolvedValue(null);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Not Found' }));
  });

  test('should inject req.organization and req.membership for a valid member', async () => {
    mockGet.mockResolvedValue(fakeOrganization);
    mockFindByUserAndOrganization.mockResolvedValue(fakeMembership);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toEqual(fakeOrganization);
    expect(req.membership).toEqual(fakeMembership);
  });

  test('should return 403 when user is not a member of the organization', async () => {
    mockGet.mockResolvedValue(fakeOrganization);
    mockFindByUserAndOrganization.mockResolvedValue(null);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
  });

  test('should bypass membership check for platform admin and inject synthetic owner membership', async () => {
    mockGet.mockResolvedValue(fakeOrganization);

    const req = mockReq({
      params: { organizationId: fakeOrgId.toString() },
      user: { _id: fakeUserId, roles: ['user', 'admin'] },
    });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(mockFindByUserAndOrganization).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toEqual(fakeOrganization);
    expect(req.membership).toEqual(expect.objectContaining({ role: 'owner', organizationId: fakeOrgId }));
  });

  test('should resolve organizationId from user.currentOrganization when no route param', async () => {
    mockGet.mockResolvedValue(fakeOrganization);
    mockFindByUserAndOrganization.mockResolvedValue(fakeMembership);

    const req = mockReq({
      user: { _id: fakeUserId, roles: ['user'], currentOrganization: fakeOrgId.toString() },
    });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toEqual(fakeOrganization);
    expect(req.membership).toEqual(fakeMembership);
  });
});
