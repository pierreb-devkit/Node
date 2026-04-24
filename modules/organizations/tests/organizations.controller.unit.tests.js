/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockCrudRemove = jest.fn();
const mockListByUser = jest.fn();

jest.unstable_mockModule('../services/organizations.crud.service.js', () => ({
  default: {
    remove: mockCrudRemove,
  },
}));

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: {
    listByUser: mockListByUser,
  },
}));

jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
  default: {
    groupIdentify: jest.fn(),
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
});
