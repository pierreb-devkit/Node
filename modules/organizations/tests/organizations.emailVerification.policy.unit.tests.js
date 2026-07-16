/**
 * Unit tests — config-gated email-verification policy
 * (config.organizations.emailVerification.mode).
 *
 * Covers BOTH modes on the two gated surfaces (signup org provisioning + domain
 * search), with the mailer reported as configured and the user UNVERIFIED — the
 * only case the mode actually changes:
 *   - 'strict' (default) → blocks the unverified user (no org, empty search).
 *   - 'off'              → always provisions / always searches (mailer-on path
 *                          behaves like a mailer-not-configured env).
 *
 * The default-strict + mailer-on + verified path stays byte-identical to today
 * and is exercised by organizations.emailVerification.unit.tests.js.
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Mutable config mock (so each test can flip emailVerification.mode) ---

const orgConfig = {
  enabled: false,
  domainMatching: false,
  emailVerification: { mode: 'strict' },
};
const configMock = {
  organizations: orgConfig,
  cookie: { secure: false, sameSite: 'strict' },
  jwt: { secret: 'test-secret', expiresIn: 3600 },
  get: jest.fn(),
};
jest.unstable_mockModule('../../../config/index.js', () => ({ default: configMock }));

// --- Mocks ---

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockIsConfigured = jest.fn();
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured, sendMail: jest.fn() },
}));

const mockOrganizationsRepositoryCreate = jest.fn();
const mockOrganizationsRepositoryList = jest.fn();
const mockOrganizationsRepositoryExists = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrganizationsRepositoryCreate,
    list: mockOrganizationsRepositoryList,
    exists: mockOrganizationsRepositoryExists,
    findOne: jest.fn(),
    get: jest.fn(),
  },
}));

const mockMembershipRepositoryCreate = jest.fn();
const mockMembershipRepositoryFindOne = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipRepositoryCreate,
    findOne: mockMembershipRepositoryFindOne,
    list: jest.fn(),
    count: jest.fn(),
  },
}));

const mockUpdateById = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    getBrut: jest.fn(),
    updateById: mockUpdateById,
    findByEmail: jest.fn(),
    searchByNameOrEmail: jest.fn(),
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

describe('Email-verification policy modes:', () => {
  const fakeUserId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    orgConfig.enabled = false;
    orgConfig.domainMatching = false;
    orgConfig.emailVerification = { mode: 'strict' };
    mockMembershipRepositoryFindOne.mockResolvedValue(null);
  });

  // --- handleSignupOrganization ---

  describe('handleSignupOrganization', () => {
    test("strict mode (default) blocks an unverified user when mailer is configured", async () => {
      orgConfig.emailVerification = { mode: 'strict' };
      mockIsConfigured.mockReturnValue(true);

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: false };
      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).toBeNull();
      expect(result.membership).toBeNull();
      expect(result.emailVerificationRequired).toBe(true);
      expect(mockOrganizationsRepositoryCreate).not.toHaveBeenCalled();
    });

    test("off mode provisions an org for an unverified user even when mailer is configured", async () => {
      orgConfig.emailVerification = { mode: 'off' };
      mockIsConfigured.mockReturnValue(true);

      const fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Test', toJSON: () => ({ name: 'Test' }) };
      const fakeMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner' };
      mockOrganizationsRepositoryCreate.mockResolvedValue(fakeOrg);
      mockMembershipRepositoryCreate.mockResolvedValue(fakeMembership);
      mockUpdateById.mockResolvedValue({});

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: false };
      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.emailVerificationRequired).toBeUndefined();
      expect(result.organization).not.toBeNull();
      expect(mockOrganizationsRepositoryCreate).toHaveBeenCalled();
    });

    test("unknown/typo mode fails closed (treated as strict) — blocks an unverified user", async () => {
      orgConfig.emailVerification = { mode: 'stict' }; // typo: not the explicit permissive 'off'
      mockIsConfigured.mockReturnValue(true);

      const user = { id: fakeUserId.toString(), email: 'test@acme.com', firstName: 'Test', lastName: 'User', emailVerified: false };
      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.emailVerificationRequired).toBe(true);
      expect(result.organization).toBeNull();
      expect(mockOrganizationsRepositoryCreate).not.toHaveBeenCalled();
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

    test("strict mode (default) returns an empty array for an unverified user when mailer is configured", async () => {
      orgConfig.emailVerification = { mode: 'strict' };
      const { default: controller } = await import('../controllers/organizations.controller.js');

      mockIsConfigured.mockReturnValue(true);
      mockOrganizationsRepositoryList.mockResolvedValue([]);

      const req = { user: { email: 'test@acme.com', emailVerified: false } };
      const res = mockRes();

      await controller.search(req, res);

      expect(mockOrganizationsRepositoryList).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', data: [] }),
      );
    });

    test("off mode runs the domain search for an unverified user even when mailer is configured", async () => {
      orgConfig.emailVerification = { mode: 'off' };
      const { default: controller } = await import('../controllers/organizations.controller.js');

      mockIsConfigured.mockReturnValue(true);
      mockOrganizationsRepositoryList.mockResolvedValue([]);

      const req = { user: { email: 'test@acme.com', emailVerified: false } };
      const res = mockRes();

      await controller.search(req, res);

      expect(mockOrganizationsRepositoryList).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
