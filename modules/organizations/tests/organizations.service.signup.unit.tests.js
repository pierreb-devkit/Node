/**
 * Unit tests — handleSignupOrganization always-create + suggestedJoin (spec D5 / A2).
 *
 * Contract:
 *  - Every signup path (autoCreate true|false × domainMatching true|false × domain public|corporate × match|no-match)
 *    returns a real `organization` + active `membership`. NEVER `organizationSetupRequired` or `pendingJoin`.
 *  - `suggestedJoin` returned ONLY when: domainMatching on + non-public domain + existing different org matches.
 *    Shape is name-only: { orgId: string, orgName: string } — no size/domain/membership keys.
 *  - Public domain (e.g. gmail.com) with same-domain existing org → NO suggestedJoin.
 *  - `organization.created` (#3952) emitted exactly once per real new org creation (billing's
 *    subscriber in billing.init.js owns crediting the grant); not double-emitted on any path.
 *
 * All assertions pass with the A2 implementation shipped in this PR.
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Mocks (must precede dynamic imports) ---

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
const mockMembershipFindOne = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: jest.fn().mockResolvedValue({}),
    list: jest.fn().mockResolvedValue([]),
    findOne: mockMembershipFindOne,
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

const mockDefineAbilityFor = jest.fn().mockResolvedValue({ rules: [] });
jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: mockDefineAbilityFor },
}));

const mockSerializeAbilities = jest.fn().mockReturnValue(['ability-stub']);
jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
  default: mockSerializeAbilities,
}));

jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
  slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
  generateOrganizationSlug: jest.fn().mockResolvedValue('alice-org'),
}));

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// #3844/#3952: capture organization.provisioned + organization.created emits — the singleton
// is config-free, stub it so assertions see the emits without wiring real listeners.
const mockOrgEventsEmit = jest.fn();
jest.unstable_mockModule('../lib/events.js', () => ({
  default: { emit: mockOrgEventsEmit, on: jest.fn() },
}));

/**
 * Filter captured `organizationEvents.emit` calls down to one event name's payloads.
 * @param {string} eventName - e.g. 'organization.created'.
 * @returns {Array<Object>} the payload of each matching emit call, in call order.
 */
const emittedPayloads = (eventName) => mockOrgEventsEmit.mock.calls.filter(([name]) => name === eventName).map(([, payload]) => payload);

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
    // resetAllMocks clears both call counts AND mockReturnValue/mockResolvedValue implementations
    // set by individual tests — prevents state leaking between describes (e.g. mockIsConfigured
    // set to true in signupGrant tests bleeding into suggestedJoin describe).
    jest.resetAllMocks();
    // Re-establish module-level defaults that resetAllMocks wipes.
    mockIsConfigured.mockReturnValue(false);
    mockOrgExists.mockResolvedValue(false);
    mockUpdateById.mockResolvedValue({});
    // Default: no active membership exists (fresh user — normal always-create path)
    mockMembershipFindOne.mockResolvedValue(null);
    // Re-establish policy + abilities mocks wiped by resetAllMocks
    mockDefineAbilityFor.mockResolvedValue({ rules: [] });
    mockSerializeAbilities.mockReturnValue(['ability-stub']);
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

  // ─── organization.created (#3952) — emitted exactly once per real new org ─

  describe('organization.created emit (billing subscribes from billing.init.js):', () => {
    test('emitted exactly once for a real new signup (autoCreate:false, no domain match)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      const user = makeUser('alice@acme.com');

      await OrganizationsService.handleSignupOrganization(user);

      const created = emittedPayloads('organization.created');
      expect(created).toHaveLength(1);
      expect(created[0]).toEqual(expect.objectContaining({ planId: 'free' }));
    });

    test('emitted exactly once for a real new signup (autoCreate:true, domain match → always-create)', async () => {
      setupConfig({ enabled: true, autoCreate: true, domainMatching: true });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@acme.com');

      await OrganizationsService.handleSignupOrganization(user);

      // One event for the newly created workspace (not for the existing org)
      expect(emittedPayloads('organization.created')).toHaveLength(1);
    });

    test('NOT emitted on email-verification early-return path', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      mockIsConfigured.mockReturnValue(true);
      const user = makeUser('alice@acme.com');
      user.emailVerified = false;

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Early return — no org created, no emit
      expect(result.organization).toBeNull();
      expect(emittedPayloads('organization.created')).toHaveLength(0);
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

  // ─── A3: domain normalization on write + exact-match read ────────────────

  describe('A3 — domain normalization (write + read, exact-match, no subdomain recursion):', () => {
    test('org created with mixed-case email → domain persisted normalized (lowercase)', async () => {
      // Asserts the canonical-normalization contract: normalizeEmailDomain (A1) is the single
      // path, so the org create call must receive a lowercased, trimmed domain.
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      mockOrgList.mockResolvedValue([]);
      const user = makeUser('dave@ACME.com');

      await OrganizationsService.handleSignupOrganization(user);

      // The org create call must receive domain: 'acme.com' (normalized)
      expect(mockOrgCreate).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'acme.com' }),
      );
    });

    test('mixed-case email matches existing org with stored lowercase domain (case-insensitive match)', async () => {
      // RED: signup from Dave@Acme.COM should match existing org stored as 'acme.com'
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      const existingOrg = makeFakeOrg({ name: 'Acme Corp', domain: 'acme.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('Dave@Acme.COM');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // suggestedJoin must be present — the normalized domain 'acme.com' matches
      expect(result.suggestedJoin).toBeDefined();
      expect(result.suggestedJoin.orgName).toBe('Acme Corp');
      // Always-create contract still holds
      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('organizationSetupRequired');
      expect(result).not.toHaveProperty('pendingJoin');
      // mockOrgList must have been called with the normalized domain
      expect(mockOrgList).toHaveBeenCalledWith(expect.objectContaining({ domain: 'acme.com' }));
    });

    test('subdomain email does NOT match org with base domain (no subdomain recursion)', async () => {
      // RED: erin@eu.acme.com must NOT match an org stored with domain 'acme.com'
      // Exact equality only — 'eu.acme.com' !== 'acme.com'
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      // Even if the repo returns a result (simulate loose DB query), the service must not suggest
      // In practice with exact-equality the repo won't be called with 'acme.com' at all —
      // it'll be called with 'eu.acme.com'. Return [] to simulate no exact match.
      mockOrgList.mockResolvedValue([]);
      const user = makeUser('erin@eu.acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // No suggestedJoin — 'eu.acme.com' !== 'acme.com'
      expect(result.suggestedJoin).toBeUndefined();
      // Always-create still holds
      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(result).not.toHaveProperty('organizationSetupRequired');
      // The lookup must have been called with the exact subdomain, not the base domain
      expect(mockOrgList).toHaveBeenCalledWith(expect.objectContaining({ domain: 'eu.acme.com' }));
    });

    test('public domain still skipped even with mixed-case email (no suggestedJoin)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true, publicDomains: [] });
      // gmail.com is in A1 PUBLIC_DOMAINS hardcoded list
      const existingOrg = makeFakeOrg({ name: 'Gmail Users', domain: 'gmail.com' });
      mockOrgList.mockResolvedValue([existingOrg]);
      const user = makeUser('alice@Gmail.COM');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.suggestedJoin).toBeUndefined();
      expect(result.organization).not.toBeNull();
    });
  });

  // ─── A4: idempotent retry-safe convergence ────────────────────────────────
  //
  // RED: current code (no guard) always calls createOrganizationForUser even when
  // an active membership already exists → duplicate org + double-credit grant.
  // GREEN: guard detects existing active membership → converges to it, skips create.

  describe('A4 — idempotent convergence (retry-safe signup provisioning):', () => {
    test('user already has active membership → returns existing org+membership, NO new org created, NO organization.created emit', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      const existingOrg = makeFakeOrg({ name: 'Existing Corp', domain: 'acme.com' });
      const existingMembership = {
        _id: new mongoose.Types.ObjectId(),
        role: 'owner',
        status: 'active',
        organizationId: existingOrg,
      };
      // Simulate: user has an active membership already (retry scenario)
      mockMembershipFindOne.mockResolvedValue(existingMembership);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Converges to existing workspace
      expect(result.organization).toBe(existingOrg);
      expect(result.membership).toBe(existingMembership);
      // No duplicate org created
      expect(mockOrgCreate).not.toHaveBeenCalled();
      // No double-credit on convergence path
      expect(emittedPayloads('organization.created')).toHaveLength(0);
      // No footgun keys
      expect(result).not.toHaveProperty('organizationSetupRequired');
      expect(result).not.toHaveProperty('pendingJoin');
    });

    test('user already has active membership (enabled:false disabled orgs) → converges, no new org', async () => {
      setupConfig({ enabled: false });
      const existingOrg = makeFakeOrg({ name: "Alice's organization" });
      const existingMembership = {
        _id: new mongoose.Types.ObjectId(),
        role: 'owner',
        status: 'active',
        organizationId: existingOrg,
      };
      mockMembershipFindOne.mockResolvedValue(existingMembership);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).toBe(existingOrg);
      expect(result.membership).toBe(existingMembership);
      expect(mockOrgCreate).not.toHaveBeenCalled();
      expect(emittedPayloads('organization.created')).toHaveLength(0);
    });

    test('genuinely new user (no existing membership) → org IS created, organization.created emitted once', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      // No active membership exists (default from beforeEach)
      mockMembershipFindOne.mockResolvedValue(null);
      const user = makeUser('bob@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.organization).not.toBeNull();
      expect(result.membership).not.toBeNull();
      expect(mockOrgCreate).toHaveBeenCalledTimes(1);
      expect(emittedPayloads('organization.created')).toHaveLength(1);
    });

    test('converge path returns abilities from policy (same shape as fresh-signup path)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      const existingOrg = makeFakeOrg();
      const existingMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner', status: 'active', organizationId: existingOrg };
      mockMembershipFindOne.mockResolvedValue(existingMembership);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      // abilities must be present (same contract as normal signup path)
      expect(result.abilities).toBeDefined();
      expect(Array.isArray(result.abilities)).toBe(true);
    });

    test('email-verification early-return precedes idempotent guard (no membership lookup when mailer gates)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
      mockIsConfigured.mockReturnValue(true);
      // Even if an active membership existed, the email-verification guard fires first
      const existingMembership = {
        _id: new mongoose.Types.ObjectId(),
        role: 'owner',
        status: 'active',
        organizationId: makeFakeOrg(),
      };
      mockMembershipFindOne.mockResolvedValue(existingMembership);
      const user = makeUser('alice@acme.com');
      user.emailVerified = false;

      const result = await OrganizationsService.handleSignupOrganization(user);

      // Email-verification path: organization null, no org created
      expect(result.organization).toBeNull();
      expect(result.emailVerificationRequired).toBe(true);
      expect(mockMembershipFindOne).not.toHaveBeenCalled();
      expect(mockOrgCreate).not.toHaveBeenCalled();
      expect(emittedPayloads('organization.created')).toHaveLength(0);
    });

    test('converge path does NOT return suggestedJoin (retry, not fresh corporate signup)', async () => {
      setupConfig({ enabled: true, autoCreate: false, domainMatching: true });
      const existingOrg = makeFakeOrg({ domain: 'acme.com' });
      const existingMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner', status: 'active', organizationId: existingOrg };
      mockMembershipFindOne.mockResolvedValue(existingMembership);
      const user = makeUser('alice@acme.com');

      const result = await OrganizationsService.handleSignupOrganization(user);

      expect(result.suggestedJoin).toBeUndefined();
      expect(result.organization).toBe(existingOrg);
    });
  });
});

describe('handleSignupOrganization — organization.provisioned emit (#3844):', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsConfigured.mockReturnValue(false);
    mockOrgExists.mockResolvedValue(false);
    mockUpdateById.mockResolvedValue({});
    mockMembershipFindOne.mockResolvedValue(null);
    mockDefineAbilityFor.mockResolvedValue({ rules: [] });
    mockSerializeAbilities.mockReturnValue(['ability-stub']);
  });

  test('fresh-create path → emits organization.created THEN organization.provisioned, each once', async () => {
    setupConfig({ enabled: true });
    const fakeOrg = makeFakeOrg();
    mockOrgCreate.mockResolvedValue(fakeOrg);
    const user = makeUser('alice@acme.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    // Two events on a genuinely new org: organization.created (#3952, billing's signupGrant
    // seam) fires inside createOrganizationForUser, THEN organization.provisioned (#3844)
    // fires back in handleSignupOrganization.
    expect(mockOrgEventsEmit).toHaveBeenCalledTimes(2);
    expect(mockOrgEventsEmit).toHaveBeenNthCalledWith(1, 'organization.created', {
      orgId: String(fakeOrg._id),
      planId: 'free',
    });
    expect(mockOrgEventsEmit).toHaveBeenNthCalledWith(2, 'organization.provisioned', {
      userId: String(user.id),
      organizationId: String(fakeOrg._id),
    });
  });

  test('A4 convergence path (existing ACTIVE membership) → emits with the EXISTING org id', async () => {
    setupConfig({ enabled: true });
    const existingOrg = makeFakeOrg();
    mockMembershipFindOne.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      role: 'owner',
      status: 'active',
      organizationId: existingOrg,
    });
    const user = makeUser('alice@acme.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).toBe(existingOrg);
    expect(mockOrgCreate).not.toHaveBeenCalled();
    // No new org → no organization.created (that only fires from createOrganizationForUser,
    // which the convergence path never calls); provisioned still fires for the converged org.
    expect(mockOrgEventsEmit).toHaveBeenCalledTimes(1);
    expect(mockOrgEventsEmit).toHaveBeenCalledWith('organization.provisioned', {
      userId: String(user.id),
      organizationId: String(existingOrg._id),
    });
  });

  test('mailer path (email verification required) → organization null, NO emit', async () => {
    setupConfig({ enabled: true });
    mockIsConfigured.mockReturnValue(true);
    const user = makeUser('alice@acme.com');
    user.emailVerified = false;

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).toBeNull();
    expect(result.emailVerificationRequired).toBe(true);
    expect(mockOrgEventsEmit).not.toHaveBeenCalled();
  });

  test('a SYNCHRONOUS listener throw is swallowed — signup result still returned', async () => {
    setupConfig({ enabled: true });
    mockOrgEventsEmit.mockImplementation(() => { throw new Error('listener exploded'); });
    const user = makeUser('alice@acme.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(result.membership).not.toBeNull();
  });
});
