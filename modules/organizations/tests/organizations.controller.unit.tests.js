/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockCrudRemove = jest.fn();
const mockCrudSwitchOrganization = jest.fn();
const mockListByUser = jest.fn();
const mockLeave = jest.fn();
const mockAdminStats = jest.fn();
const mockCrudListByUser = jest.fn();
const mockCrudCreate = jest.fn();
const mockCrudUpdate = jest.fn();
const mockCrudList = jest.fn();
const mockCrudSearchByDomain = jest.fn();

jest.unstable_mockModule('../services/organizations.crud.service.js', () => ({
  default: {
    remove: mockCrudRemove,
    switchOrganization: mockCrudSwitchOrganization,
    adminStats: mockAdminStats,
    listByUser: mockCrudListByUser,
    create: mockCrudCreate,
    update: mockCrudUpdate,
    list: mockCrudList,
    searchByDomain: mockCrudSearchByDomain,
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
const { removeSensitive } = await import('../../users/lib/users.sanitizeUser.js');
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    removeSensitive,
  },
}));

const { default: organizationsController } = await import('../controllers/organizations.controller.js');
const { default: logger } = await import('../../../lib/services/logger.js');
const { default: AppError } = await import('../../../lib/helpers/AppError.js');

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

    test('should return 409 when the last owner tries to leave', async () => {
      mockLeave.mockRejectedValue(Object.assign(new Error('Organization must have at least one active owner'), { status: 409 }));
      const req = mockReq();
      const res = mockRes();

      await organizationsController.leave(req, res);

      expect(mockLeave).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    test('should return 403 when the user is not a member', async () => {
      mockLeave.mockRejectedValue(Object.assign(new Error('You are not a member of this organization'), { status: 403 }));
      const req = mockReq();
      const res = mockRes();

      await organizationsController.leave(req, res);

      expect(mockLeave).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('adminStats', () => {
    test('should answer 500 and log the cause when the stats read fails', async () => {
      const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      mockAdminStats.mockRejectedValueOnce(new Error('aggregate failed'));
      const res = mockRes();
      await organizationsController.adminStats(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json.mock.calls[0][0].description).toBe('Unable to compute organization stats');
      expect(logSpy).toHaveBeenCalledWith('[stats] organization stats failed', expect.objectContaining({ message: 'aggregate failed' }));
      logSpy.mockRestore();
    });
  });

  describe('error status (#4304): a failed call answers the HTTP status the error carries', () => {
    test('list: an AppError 403 from the service answers 403 Forbidden', async () => {
      mockCrudListByUser.mockRejectedValueOnce(new AppError('User is not a member of this organization', { status: 403, code: 'FORBIDDEN' }));
      const res = mockRes();
      await organizationsController.list(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Forbidden', errorCode: 'FORBIDDEN' });
    });

    test('create: a slug conflict AppError answers 409 Conflict, not 422', async () => {
      mockCrudCreate.mockRejectedValueOnce(new AppError('An organization with this slug already exists.', { status: 409, code: 'CONFLICT' }));
      const res = mockRes();
      await organizationsController.create(mockReq({ body: { name: 'Acme' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Conflict', errorCode: 'CONFLICT' });
    });

    test('update: a slug conflict AppError answers 409 Conflict', async () => {
      mockCrudUpdate.mockRejectedValueOnce(new AppError('An organization with this slug already exists.', { status: 409, code: 'CONFLICT' }));
      const res = mockRes();
      await organizationsController.update(mockReq({ body: { name: 'Acme' } }), res);
      expect(mockCrudUpdate).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    test('remove: an unexpected error answers 500, never 422', async () => {
      mockCrudRemove.mockRejectedValueOnce(new Error('db down'));
      const res = mockRes();
      await organizationsController.remove(mockReq({ membership: undefined }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Internal Server Error', errorCode: 'SERVER_ERROR' });
    });

    test('adminList: an unexpected error answers 500', async () => {
      mockCrudList.mockRejectedValueOnce(new Error('db down'));
      const res = mockRes();
      await organizationsController.adminList(mockReq({ search: '', page: 0, perPage: 10 }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('search: an AppError 404 from the service answers 404 Not Found', async () => {
      mockCrudSearchByDomain.mockRejectedValueOnce(new AppError('Not found', { status: 404, code: 'NOT_FOUND' }));
      const res = mockRes();
      await organizationsController.search(mockReq({ user: { _id: 'u1', id: 'u1', email: 'a@acme.test', emailVerified: true } }), res);
      expect(mockCrudSearchByDomain).toHaveBeenCalledWith('a@acme.test');
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('switchOrganization: a non-FORBIDDEN AppError keeps its own status (404)', async () => {
      mockCrudSwitchOrganization.mockRejectedValueOnce(new AppError('Organization not found', { status: 404, code: 'NOT_FOUND' }));
      const res = mockRes();
      await organizationsController.switchOrganization(mockReq({ params: { organizationId: 'org1' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Not Found', errorCode: 'NOT_FOUND' });
    });
  });
});
