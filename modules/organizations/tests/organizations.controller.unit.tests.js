/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockCrudRemove = jest.fn();
const mockCrudSwitchOrganization = jest.fn();
const mockListByUser = jest.fn();
const mockLeave = jest.fn();

jest.unstable_mockModule('../services/organizations.crud.service.js', () => ({
  default: {
    remove: mockCrudRemove,
    switchOrganization: mockCrudSwitchOrganization,
  },
}));

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: {
    listByUser: mockListByUser,
    leave: mockLeave,
  },
}));

jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
  default: {
    groupIdentify: jest.fn(),
  },
}));

// Mock the users service boundary with the REAL sanitizeUser.removeSensitive
// (pure — lodash + config only, no mongoose) rather than a stub, so this test
// exercises actual whitelist-based stripping (#3963) instead of merely
// asserting a mock got called. Mocking the module at all is required because
// users.service.js -> users.repository.js does `mongoose.model('User')` at
// import time, which throws outside a bootstrapped app (see ERRORS.md 2026-06-04).
const { removeSensitive } = await import('../../users/utils/sanitizeUser.js');
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    removeSensitive,
  },
}));

const { default: organizationsController } = await import('../controllers/organizations.controller.js');

/**
 * Unit tests for the organizations controller remove handler.
 */
describe('Organizations controller unit tests:', () => {
  /**
   * @desc Build a minimal Express-like req object
   * @param {Object} overrides
   * @returns {Object} mock request
   */
  function mockReq(overrides = {}) {
    return {
      user: { _id: 'u1', id: 'u1', roles: ['user'] },
      organization: { _id: 'org1', id: 'org1' },
      membership: { role: 'owner' },
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
    res.cookie = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('remove', () => {
    test('should reject when a regular member tries to delete their own last organization', async () => {
      mockListByUser.mockResolvedValue([{ _id: 'mem1' }]);
      const req = mockReq();
      const res = mockRes();

      await organizationsController.remove(req, res);

      expect(mockListByUser).toHaveBeenCalledWith('u1');
      expect(res.status).toHaveBeenCalledWith(422);
      expect(mockCrudRemove).not.toHaveBeenCalled();
    });

    test('should allow a regular member to delete when they belong to several organizations', async () => {
      mockListByUser.mockResolvedValue([{ _id: 'mem1' }, { _id: 'mem2' }]);
      mockCrudRemove.mockResolvedValue({ success: true });

      const req = mockReq();
      const res = mockRes();

      await organizationsController.remove(req, res);

      expect(mockListByUser).toHaveBeenCalledTimes(1);
      expect(mockCrudRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(422);
    });

    test('should allow a global admin with zero memberships to delete any organization', async () => {
      mockCrudRemove.mockResolvedValue({ success: true });
      const req = mockReq({
        user: { _id: 'adm', id: 'adm', roles: ['user', 'admin'] },
        membership: undefined,
      });
      const res = mockRes();

      await organizationsController.remove(req, res);

      expect(mockListByUser).not.toHaveBeenCalled();
      expect(mockCrudRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(422);
    });

    test('should allow a global admin who is a member of the target org with only one membership', async () => {
      mockCrudRemove.mockResolvedValue({ success: true });
      const req = mockReq({
        user: { _id: 'adm', id: 'adm', roles: ['admin'] },
        membership: { role: 'owner' },
      });
      const res = mockRes();

      await organizationsController.remove(req, res);

      // Admin skips the last-org UX check entirely.
      expect(mockListByUser).not.toHaveBeenCalled();
      expect(mockCrudRemove).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalledWith(422);
    });
  });

  describe('switchOrganization', () => {
    /**
     * @desc Build a fake Mongoose-like updated-user document, the shape
     * `UserService.findByIdAndUpdatePopulated` returns with no `.select()` —
     * every sensitive field a real doc could carry, plus the fields the
     * response legitimately needs.
     * @returns {Object} fake mongoose document with a `toJSON` method
     */
    function fakeUpdatedUserDoc() {
      const plain = {
        _id: 'u1',
        id: 'u1',
        email: 'switcher@test.com',
        roles: ['user'],
        firstName: 'Switch',
        lastName: 'User',
        currentOrganization: 'org2',
        password: '$2b$10$leakedHashShouldNeverReachClient',
        providerData: { accessToken: 'leaked-access-token', refreshToken: 'leaked-refresh-token' },
        additionalProvidersData: { google: { accessToken: 'leaked-additional-token' } },
        resetPasswordToken: 'leaked-reset-token',
        resetPasswordExpires: new Date(),
        emailVerificationToken: 'leaked-verification-token',
        emailVerificationExpires: new Date(),
        failedLoginAttempts: 3,
        lockUntil: null,
      };
      return { ...plain, toJSON: () => plain };
    }

    test('sanitizes the response user — strips password/providerData/reset tokens, keeps legit fields', async () => {
      const updatedUser = fakeUpdatedUserDoc();
      mockCrudSwitchOrganization.mockResolvedValue({
        user: updatedUser,
        membership: { role: 'owner', organizationId: 'org2' },
      });

      const req = mockReq({
        params: { organizationId: 'org2' },
        organization: { _id: 'org2', id: 'org2' },
      });
      const res = mockRes();

      await organizationsController.switchOrganization(req, res);

      expect(mockCrudSwitchOrganization).toHaveBeenCalledWith(req.user, 'org2');
      expect(res.status).toHaveBeenCalledWith(200);
      const [payload] = res.json.mock.calls[0];
      const responseUser = payload.data.user;

      // Sensitive fields — must be ABSENT
      expect(responseUser.password).toBeUndefined();
      expect(responseUser.providerData).toBeUndefined();
      expect(responseUser.additionalProvidersData).toBeUndefined();
      expect(responseUser.resetPasswordToken).toBeUndefined();
      expect(responseUser.resetPasswordExpires).toBeUndefined();
      expect(responseUser.emailVerificationToken).toBeUndefined();
      expect(responseUser.emailVerificationExpires).toBeUndefined();
      expect(responseUser.failedLoginAttempts).toBeUndefined();
      expect(responseUser.lockUntil).toBeUndefined();

      // Legit fields — must be PRESENT
      expect(responseUser.id).toBe('u1');
      expect(responseUser.email).toBe('switcher@test.com');
      expect(responseUser.roles).toEqual(['user']);
      expect(responseUser.currentOrganization).toBe('org2');
      expect(responseUser.firstName).toBe('Switch');
    });

    test('returns 403 when the user is not a member of the target organization', async () => {
      const err = new Error('User is not a member of this organization');
      err.code = 'FORBIDDEN';
      mockCrudSwitchOrganization.mockRejectedValue(err);

      const req = mockReq({
        params: { organizationId: 'org2' },
        organization: { _id: 'org2', id: 'org2' },
      });
      const res = mockRes();

      await organizationsController.switchOrganization(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('leave', () => {
    test('should call MembershipService.leave with user and org ids and return success', async () => {
      mockLeave.mockResolvedValue({ success: true });
      const req = mockReq();
      const res = mockRes();

      await organizationsController.leave(req, res);

      expect(mockLeave).toHaveBeenCalledWith('u1', 'org1');
      expect(res.status).not.toHaveBeenCalledWith(422);
    });

    test('should return 422 when the last owner tries to leave', async () => {
      mockLeave.mockRejectedValue(new Error('Cannot remove the last owner'));
      const req = mockReq();
      const res = mockRes();

      await organizationsController.leave(req, res);

      expect(mockLeave).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    test('should return 422 when the user is not a member', async () => {
      mockLeave.mockRejectedValue(new Error('You are not a member of this organization'));
      const req = mockReq();
      const res = mockRes();

      await organizationsController.leave(req, res);

      expect(mockLeave).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(422);
    });
  });
});
