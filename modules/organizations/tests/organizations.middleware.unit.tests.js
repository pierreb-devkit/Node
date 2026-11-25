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
// resolveMembership contract: platform admin → synthetic owner membership, else the active row.
const mockResolveMembership = jest.fn(async (user, organizationId) =>
  (user?.roles?.includes('admin') ? { role: 'owner', organizationId } : mockFindByUserAndOrganization(user._id, organizationId)));
jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: { resolveMembership: mockResolveMembership, findByUserAndOrganization: mockFindByUserAndOrganization },
}));

const { default: organizationsMiddleware } = await import('../middlewares/organizations.middleware.js');
const { resolveOrganization, loadMembership } = organizationsMiddleware;

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

/**
 * Unit tests for the loadMembership middleware.
 */
describe('loadMembership middleware unit tests:', () => {
  const mockReq = (overrides = {}) => ({
    user: { _id: 'u1', id: 'u1', roles: ['user'] },
    organization: { _id: 'org1', id: 'org1' },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should attach the membership and call next() once', async () => {
    const membership = { role: 'member' };
    mockFindByUserAndOrganization.mockResolvedValueOnce(membership);
    const req = mockReq();
    const next = jest.fn();
    await loadMembership(req, {}, next);
    expect(mockFindByUserAndOrganization).toHaveBeenCalledWith('u1', 'org1');
    expect(req.membership).toBe(membership);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('should hand a DB error to next(err) once instead of swallowing it', async () => {
    const dbErr = new Error('db down');
    mockFindByUserAndOrganization.mockRejectedValueOnce(dbErr);
    const req = mockReq();
    const next = jest.fn();
    await loadMembership(req, {}, next);
    expect(req.membership).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(dbErr);
  });

  test('should skip the lookup when a membership is already set', async () => {
    const membership = { role: 'owner' };
    const req = mockReq({ membership });
    const next = jest.fn();
    await loadMembership(req, {}, next);
    expect(mockFindByUserAndOrganization).not.toHaveBeenCalled();
    expect(req.membership).toBe(membership);
    expect(next).toHaveBeenCalledWith();
  });
});
