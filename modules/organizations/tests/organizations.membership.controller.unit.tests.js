/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

const mockList = jest.fn();
const mockUpdateRole = jest.fn();
const mockRemove = jest.fn();
const mockGet = jest.fn();

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: {
    list: mockList,
    updateRole: mockUpdateRole,
    remove: mockRemove,
    get: mockGet,
  },
}));

const { default: membershipController } = await import('../controllers/organizations.membership.controller.js');

/**
 * Unit tests for the membership controller RBAC guards.
 */
describe('Membership controller unit tests:', () => {
  /**
   * @desc Build a minimal Express-like req object
   * @param {Object} overrides
   * @returns {Object} mock request
   */
  function mockReq(overrides = {}) {
    return {
      query: {},
      body: {},
      user: { _id: 'u1', roles: ['user'] },
      organization: { _id: 'org1' },
      membership: { role: MEMBERSHIP_ROLES.OWNER },
      membershipDoc: { id: 'mem1', role: MEMBERSHIP_ROLES.MEMBER, organizationId: 'org1' },
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

  describe('updateRole', () => {
    test('should reject when req.membership is missing (fail closed)', async () => {
      const req = mockReq({ membership: undefined });
      const res = mockRes();

      await membershipController.updateRole(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockUpdateRole).not.toHaveBeenCalled();
    });

    test('should reject when actor is not an owner', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN } });
      const res = mockRes();

      await membershipController.updateRole(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockUpdateRole).not.toHaveBeenCalled();
    });

    test('should allow owner to update role', async () => {
      const updatedMembership = { id: 'mem1', role: MEMBERSHIP_ROLES.ADMIN };
      mockUpdateRole.mockResolvedValue(updatedMembership);

      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, body: { role: MEMBERSHIP_ROLES.ADMIN } });
      const res = mockRes();

      await membershipController.updateRole(req, res);

      expect(mockUpdateRole).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });
  });

  describe('remove', () => {
    test('should reject when actor is a member (cannot remove anyone)', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.MEMBER }, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.MEMBER } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('should reject when req.membership is missing', async () => {
      const req = mockReq({ membership: undefined, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.MEMBER } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('should reject when admin tries to remove an owner', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN }, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.OWNER } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('should reject when admin tries to remove an admin', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN }, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.ADMIN } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('should allow admin to remove a member', async () => {
      mockRemove.mockResolvedValue({ success: true });

      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN }, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.MEMBER } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('should allow owner to remove any member', async () => {
      mockRemove.mockResolvedValue({ success: true });

      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.ADMIN } });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('should allow global admin with no org membership to remove any member', async () => {
      mockRemove.mockResolvedValue({ success: true });

      const req = mockReq({
        user: { _id: 'adm', roles: ['user', 'admin'] },
        membership: undefined,
        membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.OWNER },
      });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('should allow global admin to remove an owner even without being in the org', async () => {
      mockRemove.mockResolvedValue({ success: true });

      const req = mockReq({
        user: { _id: 'adm', roles: ['admin'] },
        membership: undefined,
        membershipDoc: { id: 'mem2', role: MEMBERSHIP_ROLES.OWNER },
      });
      const res = mockRes();

      await membershipController.remove(req, res);

      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });
  });
});
