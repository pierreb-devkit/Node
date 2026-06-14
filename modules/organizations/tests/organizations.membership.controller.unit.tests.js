/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

const mockList = jest.fn();
const mockUpdateRole = jest.fn();
const mockRemove = jest.fn();
const mockGet = jest.fn();
const mockAddMember = jest.fn();
const mockFindUserByExactEmail = jest.fn();

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: {
    list: mockList,
    updateRole: mockUpdateRole,
    remove: mockRemove,
    get: mockGet,
    addMember: mockAddMember,
    findUserByExactEmail: mockFindUserByExactEmail,
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

    test('should allow global admin with no org membership to change a role', async () => {
      const updatedMembership = { id: 'mem1', role: MEMBERSHIP_ROLES.OWNER };
      mockUpdateRole.mockResolvedValue(updatedMembership);

      const req = mockReq({
        user: { _id: 'adm', roles: ['user', 'admin'] },
        membership: undefined,
        body: { role: MEMBERSHIP_ROLES.OWNER },
      });
      const res = mockRes();

      await membershipController.updateRole(req, res);

      expect(mockUpdateRole).toHaveBeenCalledTimes(1);
      expect(mockUpdateRole).toHaveBeenCalledWith(req.membershipDoc, MEMBERSHIP_ROLES.OWNER);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test.each([
      ['non-admin non-owner (member)', { role: MEMBERSHIP_ROLES.MEMBER }, MEMBERSHIP_ROLES.ADMIN],
      ['org-level admin (not global)', { role: MEMBERSHIP_ROLES.ADMIN }, MEMBERSHIP_ROLES.OWNER],
    ])('should still reject a %s trying to change a role', async (_label, membership, targetRole) => {
      const req = mockReq({
        user: { _id: 'u1', roles: ['user'] },
        membership,
        body: { role: targetRole },
      });
      const res = mockRes();

      await membershipController.updateRole(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockUpdateRole).not.toHaveBeenCalled();
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

  describe('addMember', () => {
    test('owner can add a plain member → delegates to the service', async () => {
      mockAddMember.mockResolvedValue({ id: 'mNew', status: 'pending', source: 'owner_add' });
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, body: { userId: 'u9' } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(mockAddMember).toHaveBeenCalledTimes(1);
      // (organizationId, userId, role, addedBy)
      expect(mockAddMember).toHaveBeenCalledWith('org1', 'u9', MEMBERSHIP_ROLES.MEMBER, 'u1');
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('admin can add a plain member', async () => {
      mockAddMember.mockResolvedValue({ id: 'mNew' });
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN }, body: { userId: 'u9' } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(mockAddMember).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('a plain MEMBER cannot add anyone → 403, service not called', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.MEMBER }, body: { userId: 'u9' } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockAddMember).not.toHaveBeenCalled();
    });

    test('a non-member (no req.membership) cannot add anyone → 403, fail closed', async () => {
      const req = mockReq({ user: { _id: 'u1', roles: ['user'] }, membership: undefined, body: { userId: 'u9' } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockAddMember).not.toHaveBeenCalled();
    });

    test('admin CANNOT add an elevated role (owner/admin) → 403, service not called', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.ADMIN }, body: { userId: 'u9', role: MEMBERSHIP_ROLES.ADMIN } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockAddMember).not.toHaveBeenCalled();
    });

    test('owner CAN add an elevated role', async () => {
      mockAddMember.mockResolvedValue({ id: 'mNew' });
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, body: { userId: 'u9', role: MEMBERSHIP_ROLES.OWNER } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(mockAddMember).toHaveBeenCalledWith('org1', 'u9', MEMBERSHIP_ROLES.OWNER, 'u1');
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('global admin can add an elevated role even with no org membership', async () => {
      mockAddMember.mockResolvedValue({ id: 'mNew' });
      const req = mockReq({
        user: { _id: 'adm', roles: ['admin'] },
        membership: undefined,
        body: { userId: 'u9', role: MEMBERSHIP_ROLES.ADMIN },
      });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(mockAddMember).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('a service rejection surfaces as 422', async () => {
      mockAddMember.mockRejectedValue(new Error('User is already a member of this organization'));
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, body: { userId: 'u9' } });
      const res = mockRes();

      await membershipController.addMember(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
    });
  });

  describe('findUserByEmail', () => {
    test('owner gets a matched user', async () => {
      mockFindUserByExactEmail.mockResolvedValue({ id: 'u9', displayName: 'Ada Lovelace', email: 'ada@x.com' });
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, query: { email: 'ada@x.com' } });
      const res = mockRes();

      await membershipController.findUserByEmail(req, res);

      expect(mockFindUserByExactEmail).toHaveBeenCalledWith('ada@x.com');
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('a plain MEMBER cannot enumerate users → 403 (CASL read is too broad for this surface)', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.MEMBER }, query: { email: 'ada@x.com' } });
      const res = mockRes();

      await membershipController.findUserByEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockFindUserByExactEmail).not.toHaveBeenCalled();
    });

    test('missing email query → 422', async () => {
      const req = mockReq({ membership: { role: MEMBERSHIP_ROLES.OWNER }, query: {} });
      const res = mockRes();

      await membershipController.findUserByEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(mockFindUserByExactEmail).not.toHaveBeenCalled();
    });
  });
});
