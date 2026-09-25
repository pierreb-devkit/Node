/**
 * Unit tests — welcome email after signup (Node#4116).
 *
 * Contract (see `sendWelcomeEmail` in organizations.service.js):
 *  - Sent from BOTH create branches of `handleSignupOrganization` (organizations
 *    enabled or disabled) — exactly once per real new workspace.
 *  - NEVER sent on the A4 convergence path (existing active membership).
 *  - Gated on `config.organizations.welcomeEmail.enabled` (default true) AND
 *    `mailer.isConfigured()` — either gate off means no send.
 *  - B2C mode (organizations disabled) omits `orgName` from the template params.
 *  - Fire-and-forget: a rejecting send, or a send call that doesn't even return
 *    a promise, must never break the signup flow.
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Mocks (must precede dynamic imports) ---

const mockIsConfigured = jest.fn().mockReturnValue(true);
const mockSendMail = jest.fn().mockResolvedValue({ accepted: ['a@b.com'], rejected: [] });
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured, sendMail: mockSendMail },
}));

const mockOrgCreate = jest.fn();
const mockOrgList = jest.fn().mockResolvedValue([]);
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

const mockDefineAbilityFor = jest.fn().mockResolvedValue({ rules: [] });
jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: mockDefineAbilityFor },
}));

jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
  default: jest.fn().mockReturnValue(['ability-stub']),
}));

jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
  /**
   * Lowercase and hyphenate a string for use as a slug (test stub).
   * @param {string} str - The string to slugify.
   * @returns {string} The slugified string.
   */
  slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
  generateOrganizationSlug: jest.fn().mockResolvedValue('alice-org'),
}));

const mockLoggerWarn = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: mockLoggerWarn, info: jest.fn() },
}));

jest.unstable_mockModule('../lib/events.js', () => ({
  default: { emit: jest.fn(), on: jest.fn() },
}));

// Config store — MUST be mutated in-place (jest.unstable_mockModule captures the
// default export value at import time; reassigning the variable breaks the binding).
const configStore = { organizations: {}, app: { title: 'Acme App', contact: 'hi@acme.test' }, cors: { origin: 'https://app.acme.test' } };
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: configStore,
}));

// --- Dynamic import after all mocks ---
const { default: OrganizationsService } = await import('../services/organizations.service.js');

/**
 * Configure config mock and repository happy-path defaults for a fresh signup.
 * Must mutate configStore's `organizations` key in-place.
 * @param {Object} orgConfig - `config.organizations` values.
 * @returns {Object} The fake organization document `OrganizationsRepository.create` resolves to.
 */
function setupConfig(orgConfig) {
  configStore.organizations = { publicDomains: [], ...orgConfig };
  const fakeOrg = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Acme Corp',
    slug: 'acme',
    domain: '',
    plan: 'free',
    /**
     * Serialize the fake organization to its public JSON shape (test stub).
     * @returns {{_id: import('mongoose').Types.ObjectId, name: string}} The serialized organization.
     */
    toJSON() {
      return { _id: this._id, name: this.name };
    },
  };
  mockOrgCreate.mockResolvedValue(fakeOrg);
  mockMembershipCreate.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), role: 'owner' });
  return fakeOrg;
}

/**
 * Build a minimal user object for testing.
 * @param {string} email
 * @returns {Object}
 */
function makeUser(email = 'alice@example.com') {
  return {
    id: new mongoose.Types.ObjectId().toString(),
    _id: new mongoose.Types.ObjectId().toString(),
    email,
    firstName: 'Alice',
    lastName: 'Smith',
    emailVerified: true,
  };
}

describe('handleSignupOrganization — welcome email (Node#4116):', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    mockSendMail.mockResolvedValue({ accepted: ['a@b.com'], rejected: [] });
    mockOrgExists.mockResolvedValue(false);
    mockOrgList.mockResolvedValue([]);
    mockMembershipFindOne.mockResolvedValue(null);
    mockUpdateById.mockResolvedValue({});
    mockDefineAbilityFor.mockResolvedValue({ rules: [] });
  });

  test('sent once on a fresh create, orgs enabled — includes orgName', async () => {
    const fakeOrg = setupConfig({ enabled: true, autoCreate: false, domainMatching: false });
    const user = makeUser('alice@corp.example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledWith({
      template: 'welcome',
      to: user.email,
      subject: 'Welcome to Acme App',
      params: {
        displayName: 'Alice Smith',
        url: 'https://app.acme.test',
        appName: 'Acme App',
        appContact: 'hi@acme.test',
        orgName: fakeOrg.name,
      },
    });
  });

  test('sent once on a fresh create, orgs disabled (B2C) — no orgName in params', async () => {
    setupConfig({ enabled: false });
    const user = makeUser('bob@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const { params } = mockSendMail.mock.calls[0][0];
    expect(params).not.toHaveProperty('orgName');
  });

  test('NOT sent on the A4 convergence path (existing active membership)', async () => {
    setupConfig({ enabled: true });
    const existingOrg = { _id: new mongoose.Types.ObjectId(), name: 'Existing Org' };
    mockMembershipFindOne.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), role: 'owner', status: 'active', organizationId: existingOrg });
    const user = makeUser('carol@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).toBe(existingOrg);
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('NOT sent when config.organizations.welcomeEmail.enabled is false', async () => {
    setupConfig({ enabled: true, welcomeEmail: { enabled: false } });
    const user = makeUser('dave@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(mockOrgCreate).toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('NOT sent when the mailer is not configured — signup still succeeds', async () => {
    setupConfig({ enabled: true });
    mockIsConfigured.mockReturnValue(false);
    const user = makeUser('erin@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a rejecting sendMail does not break signup — failure is traceable (userId + orgId)', async () => {
    const fakeOrg = setupConfig({ enabled: true });
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
    const user = makeUser('frank@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);
    // Flush the fire-and-forget promise chain so its .catch() runs before we assert.
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.organization).not.toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith('organizations: welcome email failed', expect.objectContaining({
      message: 'smtp down',
      userId: user.id,
      orgId: String(fakeOrg._id),
    }));
  });

  test('a rejecting sendMail in B2C mode still logs orgId (hidden default org is in scope)', async () => {
    const fakeOrg = setupConfig({ enabled: false });
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
    const user = makeUser('heidi@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.organization).not.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith('organizations: welcome email failed', expect.objectContaining({
      userId: user.id,
      orgId: String(fakeOrg._id),
    }));
  });

  test('a sendMail call that does not return a promise does not break signup', async () => {
    setupConfig({ enabled: true });
    mockSendMail.mockReturnValueOnce(undefined);
    const user = makeUser('grace@example.com');

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).not.toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith('organizations: welcome email failed', expect.anything());
  });
});
