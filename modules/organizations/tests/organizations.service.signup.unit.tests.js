/**
 * Unit tests — handleSignupOrganization always-create + suggestedJoin (spec D5 / A2).
 *
 * Contract:
 *  - Every signup path (autoCreate true|false × domainMatching true|false × domain public|corporate × match|no-match)
 *    returns a real `organization` + active `membership`. NEVER `organizationSetupRequired` or `pendingJoin`.
 *  - `suggestedJoin` returned ONLY when: domainMatching on + non-public domain + existing different org matches.
 *    Shape is name-only: { orgId: string, orgName: string } — no size/domain/membership keys.
 *  - Public domain (e.g. gmail.com) with same-domain existing org → NO suggestedJoin.
 *  - signupGrant credited exactly once per real new org creation (via BillingSignupGrantService.grantOnSignup);
 *    not double-credited on any path.
 *
 * RED: written before A2 implementation — current code fails these assertions.
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Mocks (must precede dynamic imports) ---

const mockGrantOnSignup = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../../billing/services/billing.signupGrant.service.js', () => ({
  default: { grantOnSignup: mockGrantOnSignup },
}));

const mockIsConfigured = jest.fn().mockReturnValue(false);
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured },
}));

const mockOrgCreate = jest.fn();
const mockOrgList = jest.fn();
const mockOrgExists = jest.fn().mockResolvedValue(false);
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrgCreate,
    list: mockOrgList,
    exists: mockOrgExists,
    remove: jest.fn().mockResolvedValue({}),
  },
}));

const mockMembershipCreate = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: jest.fn().mockResolvedValue({}),
    list: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

const mockUpdateById = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { updateById: mockUpdateById },
}));

// MembershipService.createJoinRequest should never be called after A2
const mockCreateJoinRequest = jest.fn();
jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: { createJoinRequest: mockCreateJoinRequest },
}));

jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: jest.fn().mockResolvedValue({ rules: [] }) },
}));

jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
  default: jest.fn().mockReturnValue(['ability-stub']),
}));

jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
  slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
  generateOrganizationSlug: jest.fn().mockResolvedValue('alice-org'),
}));

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// Config store — MUST be mutated in-place (not reassigned) because jest.unstable_mockModule
// captures the default export value at import time. Object.assign ensures live updates.
const configStore = { organizations: {} };
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: configStore,
}));

// --- Dynamic import after all mocks ---
const { default: OrganizationsService } = await import('../services/organizations.service.js');

// --- Helpers ---

/**
 * Build a minimal user object for testing.
 * @param {string} email
 * @returns {Object}
 */
function makeUser(email = 'alice@acme.com') {
  return {
    id: new mongoose.Types.ObjectId().toString(),
    _id: new mongoose.Types.ObjectId().toString(),
    email,
    firstName: 'Alice',
    lastName: 'Smith',
    emailVerified: true,
  };
}

/**
 * Build a fake organization document returned by the repository.
 * @param {Object} overrides
 * @returns {Object}
 */
function makeFakeOrg(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  return {
    _id,
    name: overrides.name || 'Acme Corp',
    slug: overrides.slug || 'acme',
    domain: overrides.domain || 'acme.com',
    plan: 'free',
    toJSON() { return { _id: this._id, name: this.name, slug: this.slug, domain: this.domain }; },
    ...overrides,
  };
}

/**
 * Build a fake membership document.
 * @returns {Object}
 */
function makeFakeMembership() {
  return { _id: new mongoose.Types.ObjectId(), role: 'owner' };
}

/**
 * Configure config mock and repository happy-path defaults.
 * Must mutate configStore IN-PLACE (not reassign) because the mock module captures
 * the object reference at import time — reassigning the variable breaks the binding.
 * @param {Object} orgConfig - `config.organizations` values
 */
function setupConfig(orgConfig) {
  // Clear and repopulate in-place
  Object.keys(configStore).forEach((k) => delete configStore[k]);
  Object.assign(configStore, { organizations: { publicDomains: [], ...orgConfig } });
  mockOrgCreate.mockResolvedValue(makeFakeOrg());
  mockMembershipCreate.mockResolvedValue(makeFakeMembership());
  mockOrgList.mockResolvedValue([]);
  mockUpdateById.mockResolvedValue({});
}

// --- Tests ---

describe('handleSignupOrganization — always-create (spec D5 / A2):', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Core invariant: always returns a real org + membership ──────────────

  describe('autoCreate:false — footgun branch deleted:', () => {
    test('non-public domain, no existing org → creates workspace, no suggestedJoin', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('organizationSetupRequired');
      expect(result).not.toHaveProperty('pendingJoin');
      expect(result.suggestedJoin).toBeUndefined();
    });

    test('public domain → creates workspace, no suggestedJoin', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: ['gmail.com'] });
      const user = makeUser('alice@gmail.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result.suggestedJoin).toBeUndefined();
      expect(result).not.toHaveProperty('organizationSetupRequired');
    });

    test('domainMatching on, non-public, existing org → creates workspace + suggestedJoin name-only', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Always creates own workspace
      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('organizationSetupRequired');
      expect(result).not.toHaveProperty('pendingJoin');

      // suggestedJoin is name-only
      expect(result.suggestedJoin).toBeDefined();
      expect(result.suggestedJoin.orgId).toBeDefined();
      expect(result.suggestedJoin.orgName).toBe('Acme Corp');
      // Must NOT leak sensitive fields
      expect(result.suggestedJoin).not.toHaveProperty('domain');
      expect(result.suggestedJoin).not.toHaveProperty('memberCount');
      expect(result.suggestedJoin).not.toHaveProperty('membership');
      expect(result.suggestedJoin).not.toHaveProperty('plan');
    });

    test('domainMatching on, public domain, existing org → NO suggestedJoin', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: ['gmail.com'] });
      const existingOrg = makeFakeOrg({ name: 'Gmail Users', domain: 'gmail.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@gmail.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.suggestedJoin).toBeUndefined();
    });
  });

  describe('autoCreate:true — existing paths preserved, same always-create guarantee:', () => {
    test('domainMatching off → creates personal workspace', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: false });
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('organizationSetupRequired');
      expect(result).not.toHaveProperty('pendingJoin');
      expect(result.suggestedJoin).toBeUndefined();
    });

    test('domainMatching on, non-public, no existing org → creates domain-named workspace', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: true });
      mockOrgList.mockResolvedValue([]);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('pendingJoin');
      expect(result.suggestedJoin).toBeUndefined();
    });

    test('domainMatching on, non-public, existing org → creates own workspace + suggestedJoin (no pendingJoin/join-request)', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: true });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Always creates own workspace — MembershipService.createJoinRequest must NOT be called
      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(mockCreateJoinRequest).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('pendingJoin');

      // suggestedJoin returned, name-only
      expect(result.suggestedJoin).toBeDefined();
      expect(result.suggestedJoin.orgName).toBe('Acme Corp');
    });

    test('domainMatching on, public domain (gmail), existing org → NO suggestedJoin', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: true, publicDomains: ['gmail.com'] });
      const existingOrg = makeFakeOrg({ name: 'Gmail Users', domain: 'gmail.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@gmail.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.suggestedJoin).toBeUndefined();
    });
  });

  describe('organizations disabled (enabled:false) — silent default org:', () => {
    test('always creates workspace', async () => {
      setupConfig({ enabled: false });
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result.suggestedJoin).toBeUndefined();
      expect(result).not.toHaveProperty('organizationSetupRequired');
    });
  });

  // ─── signupGrant — credited exactly once per real new org ────────────────

  describe('signupGrant (BillingSignupGrantService):', () => {
    test('credited exactly once for a real new signup (autoCreate:false, no domain match)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      const user = makeUser('alice@acme.com');

      await OrganizationsService.handleSignupOrganization(user);

      expect(mockGrantOnSignup).toHaveBeenCalledTimes(1);
      expect(mockGrantOnSignup).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'free' }),
      );
    });

    test('credited exactly once for a real new signup (autoCreate:true, domain match → always-create)', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: true });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@acme.com');

      await OrganizationsService.handleSignupOrganization(user);

      // One grant for the newly created workspace (not for the existing org)
      expect(mockGrantOnSignup).toHaveBeenCalledTimes(1);
    });

    test('NOT called on email-verification early-return path', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      mockIsConfigured.mockReturnValue(true);
      const user = makeUser('alice@acme.com');
      user.emailVerified = false;

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Early return — no org created, no grant
      expect(result.organization).toBeNull();
      expect(mockGrantOnSignup).not.toHaveBeenCalled();
    });
  });

  // ─── suggestedJoin shape / isolation ─────────────────────────────────────

  describe('suggestedJoin shape:', () => {
    test('orgId is a string representation of the matched org id', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(typeof result.suggestedJoin.orgId).toBe('string');
      expect(result.suggestedJoin.orgId).toBe(existingOrg._id.toString());
    });

    test('suggestedJoin uses isPublicDomain (A1) for the public-domain gate', async () => {
      // Use the A1 PUBLIC_DOMAINS list — icloud.com is in it
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      const existingOrg = makeFakeOrg({ name: 'iCloud Corp', domain: 'icloud.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@icloud.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // icloud.com is in A1's PUBLIC_DOMAINS hardcoded list — should not suggest
      expect(result.suggestedJoin).toBeUndefined();
    });

    test('MembershipService.createJoinRequest is NEVER called on any path', async () => {
      // Test all paths that previously called createJoinRequest
      for (const autoCreate of [true, false]) {
        jest.clearAllMocks();
        setupConfig({ enabled: true, autoCreate, domainMatching: true });
        const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
        mockOrgList.mockResolvedValue([existingOrg]);
        const user = makeUser('alice@acme.com');

        await OrganizationsService.handleSignupOrganization(user);

        expect(mockCreateJoinRequest).not.toHaveBeenCalled();
      }
    });
  });
});
