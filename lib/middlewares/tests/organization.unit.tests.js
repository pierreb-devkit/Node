/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { jest, describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';

/**
 * Unit tests for the resolveOrganization middleware.
 */
describe('resolveOrganization middleware unit tests:', () => {
  let resolveOrganization;
  let Organization;
  let Membership;

  const fakeOrgId = new mongoose.Types.ObjectId();
  const fakeUserId = new mongoose.Types.ObjectId();

  const fakeOrganization = { _id: fakeOrgId, name: 'Test Org', slug: 'test-org' };
  const fakeMembership = { _id: new mongoose.Types.ObjectId(), userId: fakeUserId, organizationId: fakeOrgId, role: 'member' };

  beforeAll(async () => {
    // Ensure Mongoose models are registered (import model files for side-effects)
    await import('../../../modules/organizations/models/organizations.model.mongoose.js');
    await import('../../../modules/organizations/models/organizations.membership.model.mongoose.js');

    Organization = mongoose.model('Organization');
    Membership = mongoose.model('Membership');

    const mod = await import('../organization.js');
    resolveOrganization = mod.default.resolveOrganization;
  });

  /**
   * Helper to build a minimal Express-like req object.
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
   * Helper to build a minimal Express-like res object with spies.
   * @returns {Object} mock response
   */
  function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.restoreAllMocks();
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
    jest.spyOn(Organization, 'findById').mockResolvedValue(null);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Not Found' }));
  });

  test('should inject req.organization and req.membership for a valid member', async () => {
    jest.spyOn(Organization, 'findById').mockResolvedValue(fakeOrganization);
    jest.spyOn(Membership, 'findOne').mockResolvedValue(fakeMembership);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toEqual(fakeOrganization);
    expect(req.membership).toEqual(fakeMembership);
  });

  test('should return 403 when user is not a member of the organization', async () => {
    jest.spyOn(Organization, 'findById').mockResolvedValue(fakeOrganization);
    jest.spyOn(Membership, 'findOne').mockResolvedValue(null);

    const req = mockReq({ params: { organizationId: fakeOrgId.toString() } });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
  });

  test('should bypass membership check for platform admin and inject synthetic owner membership', async () => {
    jest.spyOn(Organization, 'findById').mockResolvedValue(fakeOrganization);
    const membershipSpy = jest.spyOn(Membership, 'findOne');

    const req = mockReq({
      params: { organizationId: fakeOrgId.toString() },
      user: { _id: fakeUserId, roles: ['user', 'admin'] },
    });
    const res = mockRes();
    const next = jest.fn();

    await resolveOrganization(req, res, next);

    expect(membershipSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.organization).toEqual(fakeOrganization);
    expect(req.membership).toEqual(expect.objectContaining({ role: 'owner', organizationId: fakeOrgId }));
  });

  test('should resolve organizationId from user.currentOrganization when no route param', async () => {
    jest.spyOn(Organization, 'findById').mockResolvedValue(fakeOrganization);
    jest.spyOn(Membership, 'findOne').mockResolvedValue(fakeMembership);

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

  afterAll(() => {
    jest.restoreAllMocks();
  });
});
