/**
 * Unit tests for email verification gates on organization operations.
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Mocks ---

// rule 2 (Node#4020): isolate the org-creation seam GENERICALLY — mock the hook
// mechanism itself (lib/events.js, a plain EventEmitter registry any consumer
// module can subscribe to), never a specific consumer's own listener module.
// A bare double (not a real EventEmitter) — same convention already used by
// organizations.service.silent.catch.unit.tests.js and
// organizations.service.signup.unit.tests.js, which already covers the
// organization.created/organization.provisioned payload shape and ordering
// generically via this exact mock, so this file only needs isolation, not a
// second copy of that coverage.
jest.unstable_mockModule('../lib/events.js', () => ({
  default: { emit: jest.fn(), on: jest.fn() },
}));

const mockIsConfigured = jest.fn();
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured, sendMail: jest.fn() },
}));

const mockOrganizationsRepositoryCreate = jest.fn();
const mockOrganizationsRepositoryList = jest.fn();
const mockOrganizationsRepositoryExists = jest.fn();
const mockOrganizationsRepositoryFindOne = jest.fn();
const mockOrganizationsRepositoryGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrganizationsRepositoryCreate,
    list: mockOrganizationsRepositoryList,
    exists: mockOrganizationsRepositoryExists,
    findOne: mockOrganizationsRepositoryFindOne,
    get: mockOrganizationsRepositoryGet,
  },
}));

const mockMembershipRepositoryCreate = jest.fn();
const mockMembershipRepositoryFindOne = jest.fn();
const mockMembershipRepositoryList = jest.fn();
const mockMembershipRepositoryCount = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipRepositoryCreate,
    findOne: mockMembershipRepositoryFindOne,
    list: mockMembershipRepositoryList,
    count: mockMembershipRepositoryCount,
  },
}));

const mockGetBrut = jest.fn();
const mockUpdateById = jest.fn();
const mockFindByEmail = jest.fn();
const mockSearchByNameOrEmail = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    getBrut: mockGetBrut,
    updateById: mockUpdateById,
    findByEmail: mockFindByEmail,
    searchByNameOrEmail: mockSearchByNameOrEmail,
  },
}));

jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: jest.fn().mockResolvedValue({ rules: [] }) },
}));

jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
  default: jest.fn().mockReturnValue([]),
}));

jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
  slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
  generateOrganizationSlug: jest.fn().mockResolvedValue('test-slug'),
}));

// --- Dynamic imports after mocks ---

const { default: OrganizationsService } = await import('../services/organizations.service.js');
const { default: OrganizationsCrudService } = await import('../services/organizations.crud.service.js');
const { default: MembershipService } = await import('../services/organizations.membership.service.js');

describe('Email verification gates:', () => {
  const fakeUserId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  // --- handleSignupOrganization ---

  describe('handleSignupOrganization', () => {
    test('should skip org provisioning when mailer is configured and email is not verified', async () => {
      mockIsConfigured.mockReturnValue(true);

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: false };
      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).toBeNull();
      expect(result.membership).toBeNull();
      expect(result.emailVerificationRequired).toBe(true);
      // organizationSetupRequired and pendingJoin removed — spec D5: service no longer
      // returns these keys; signup always provisions a workspace post-verification.
    });

    test('should proceed normally when mailer is not configured', async () => {
      mockIsConfigured.mockReturnValue(false);

      const fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Test', toJSON: () => ({ name: 'Test' }) };
      const fakeMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner' };
      mockOrganizationsRepositoryCreate.mockResolvedValue(fakeOrg);
      mockMembershipRepositoryCreate.mockResolvedValue(fakeMembership);
      mockUpdateById.mockResolvedValue({});

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: false };
      const result = await OrganizationsService.handleSignupOrganization(user);

      // Should have created an org (organizations disabled path)
      expect(result.organization).toBeDefined();
      expect(result.organization).not.toBeNull();
    });

    test('should proceed normally when mailer is configured and email is verified', async () => {
      mockIsConfigured.mockReturnValue(true);

      const fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Test', toJSON: () => ({ name: 'Test' }) };
      const fakeMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner' };
      mockOrganizationsRepositoryCreate.mockResolvedValue(fakeOrg);
      mockMembershipRepositoryCreate.mockResolvedValue(fakeMembership);
      mockUpdateById.mockResolvedValue({});

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: true };
      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).toBeDefined();
      expect(result.organization).not.toBeNull();
    });
  });

  // --- create (crud service) ---

  describe('OrganizationsCrudService.create', () => {
    test('should throw FORBIDDEN when mailer is configured and email is not verified', async () => {
      mockIsConfigured.mockReturnValue(true);

      const user = { id: fakeUserId.toString(), emailVerified: false };
      await expect(OrganizationsCrudService.create({ name: 'Acme' }, user)).rejects.toThrow('Email verification required before this action');
    });

    test('should proceed when mailer is not configured', async () => {
      mockIsConfigured.mockReturnValue(false);

      const fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Acme' };
      const fakeMembership = { _id: new mongoose.Types.ObjectId() };
      mockOrganizationsRepositoryFindOne.mockResolvedValue(null);
      mockOrganizationsRepositoryCreate.mockResolvedValue(fakeOrg);
      mockMembershipRepositoryCreate.mockResolvedValue(fakeMembership);
      mockUpdateById.mockResolvedValue({});

      const user = { id: fakeUserId.toString(), emailVerified: false };
      const result = await OrganizationsCrudService.create({ name: 'Acme' }, user);

      expect(result).toBeDefined();
      expect(mockOrganizationsRepositoryCreate).toHaveBeenCalled();
    });

    test('should proceed when mailer is configured and email is verified', async () => {
      mockIsConfigured.mockReturnValue(true);

      const fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Acme' };
      const fakeMembership = { _id: new mongoose.Types.ObjectId() };
      mockOrganizationsRepositoryFindOne.mockResolvedValue(null);
      mockOrganizationsRepositoryCreate.mockResolvedValue(fakeOrg);
      mockMembershipRepositoryCreate.mockResolvedValue(fakeMembership);
      mockUpdateById.mockResolvedValue({});

      const user = { id: fakeUserId.toString(), emailVerified: true };
      const result = await OrganizationsCrudService.create({ name: 'Acme' }, user);

      expect(result).toBeDefined();
      expect(mockOrganizationsRepositoryCreate).toHaveBeenCalled();
    });
  });

  // --- createJoinRequest ---

  describe('MembershipService.createJoinRequest', () => {
    test('should throw FORBIDDEN when mailer is configured and email is not verified', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockGetBrut.mockResolvedValue({ _id: fakeUserId, email: 'test@acme.com', emailVerified: false });

      const orgId = new mongoose.Types.ObjectId().toString();
      await expect(MembershipService.createJoinRequest(fakeUserId.toString(), orgId)).rejects.toThrow('Email verification required before this action');
    });

    test('should proceed when mailer is not configured', async () => {
      mockIsConfigured.mockReturnValue(false);
      mockGetBrut.mockResolvedValue({ _id: fakeUserId, email: 'test@acme.com', emailVerified: false });
      mockMembershipRepositoryFindOne.mockResolvedValue(null);
      mockMembershipRepositoryCreate.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), status: 'pending' });

      const orgId = new mongoose.Types.ObjectId().toString();
      const result = await MembershipService.createJoinRequest(fakeUserId.toString(), orgId);

      expect(result).toBeDefined();
      expect(mockMembershipRepositoryCreate).toHaveBeenCalled();
    });

    test('should proceed when mailer is configured and email is verified', async () => {
      mockIsConfigured.mockReturnValue(true);
      mockGetBrut.mockResolvedValue({ _id: fakeUserId, email: 'test@acme.com', emailVerified: true });
      mockMembershipRepositoryFindOne.mockResolvedValue(null);
      mockMembershipRepositoryCreate.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), status: 'pending' });

      const orgId = new mongoose.Types.ObjectId().toString();
      const result = await MembershipService.createJoinRequest(fakeUserId.toString(), orgId);

      expect(result).toBeDefined();
      expect(mockMembershipRepositoryCreate).toHaveBeenCalled();
    });
  });

  // --- search controller gate ---

  describe('search controller gate', () => {
    /**
     * @desc Build a minimal Express-like res object with spies.
     * @returns {Object} mock response
     */
    function mockRes() {
      const res = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    }

    test('should return empty array when mailer is configured and email is not verified', async () => {
      // Import controller after mocks are set up
      const { default: controller } = await import('../controllers/organizations.controller.js');

      mockIsConfigured.mockReturnValue(true);
      mockOrganizationsRepositoryList.mockResolvedValue([]);

      const req = { user: { email: 'test@acme.com', emailVerified: false } };
      const res = mockRes();

      await controller.search(req, res);

      // searchByDomain should NOT have been called in the blocked branch
      expect(mockOrganizationsRepositoryList).not.toHaveBeenCalled();
      // Should return success with empty array
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          data: [],
        }),
      );
    });

    test('should call searchByDomain when mailer is not configured', async () => {
      const { default: controller } = await import('../controllers/organizations.controller.js');

      mockIsConfigured.mockReturnValue(false);
      mockOrganizationsRepositoryList.mockResolvedValue([]);

      const req = { user: { email: 'test@acme.com', emailVerified: false } };
      const res = mockRes();

      await controller.search(req, res);

      expect(mockOrganizationsRepositoryList).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('should call searchByDomain when mailer is configured and email is verified', async () => {
      const { default: controller } = await import('../controllers/organizations.controller.js');

      mockIsConfigured.mockReturnValue(true);
      mockOrganizationsRepositoryList.mockResolvedValue([]);

      const req = { user: { email: 'test@acme.com', emailVerified: true } };
      const res = mockRes();

      await controller.search(req, res);

      expect(mockOrganizationsRepositoryList).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
