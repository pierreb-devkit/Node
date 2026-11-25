/**
 * Unit tests — handleSignupOrganization signup join (membership resolver registry).
 *
 * Contract:
 *  - No resolver registered (or none answers) → today's behaviour: a personal workspace.
 *  - A resolver names an existing organization → ACTIVE membership with the resolved role and
 *    `addedBy`, `currentOrganization` set, A4 converges: no new org, no `organization.created`.
 *  - Organization gone → personal workspace, no crash.
 *  - A membership row already exists for (user, org) → no second row.
 *  - `currentOrganization` write fails → the membership is rolled back, the error propagates.
 *  - Strict verification + mailer + unverified user → resolvers are not asked (join at verifyEmail).
 */
import mongoose from 'mongoose';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockIsConfigured = jest.fn().mockReturnValue(false);
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured, sendMail: jest.fn().mockResolvedValue(null), getBrand: jest.fn().mockReturnValue({ name: 'Test App' }) },
}));

const mockOrgCreate = jest.fn();
const mockOrgGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrgCreate,
    get: mockOrgGet,
    list: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(false),
    remove: jest.fn().mockResolvedValue({}),
  },
}));

const mockMembershipCreate = jest.fn();
const mockMembershipFindOne = jest.fn();
const mockMembershipDeleteMany = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: mockMembershipDeleteMany,
    list: jest.fn().mockResolvedValue([]),
    findOne: mockMembershipFindOne,
  },
}));

const mockUpdateById = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { updateById: mockUpdateById },
}));

jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: jest.fn().mockResolvedValue({ rules: [] }) },
}));
jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({ default: jest.fn().mockReturnValue([]) }));
jest.unstable_mockModule('../lib/organizations.slug.js', () => ({
  slugify: (str) => str.toLowerCase(),
  generateOrganizationSlug: jest.fn().mockResolvedValue('alice-org'),
}));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const mockOrgEventsEmit = jest.fn();
jest.unstable_mockModule('../lib/organizations.events.js', () => ({
  default: { emit: mockOrgEventsEmit, on: jest.fn() },
}));

const configStore = { organizations: {} };
jest.unstable_mockModule('../../../config/index.js', () => ({ default: configStore }));

const { default: OrganizationsService } = await import('../services/organizations.service.js');
const SignupRegistry = (await import('../lib/organizations.signup.registry.js')).default;

const emitted = (name) => mockOrgEventsEmit.mock.calls.filter(([n]) => n === name);

/**
 * @desc Minimal signing-up user.
 * @returns {Object}
 */
const makeUser = () => {
  const id = new mongoose.Types.ObjectId().toString();
  return { id, _id: id, email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', emailVerified: true };
};

describe('handleSignupOrganization — signup join', () => {
  let user;
  let invitedOrg;
  let inviterId;

  beforeEach(() => {
    jest.clearAllMocks();
    SignupRegistry._reset();
    Object.assign(configStore, { organizations: { enabled: true, domainMatching: false, emailVerification: { mode: 'strict' } } });
    mockIsConfigured.mockReturnValue(false);
    user = makeUser();
    invitedOrg = { _id: new mongoose.Types.ObjectId(), name: 'Acme' };
    inviterId = new mongoose.Types.ObjectId();
    mockOrgGet.mockResolvedValue(invitedOrg);
    mockUpdateById.mockResolvedValue({});
    mockMembershipFindOne.mockResolvedValue(null);
    mockMembershipCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
    mockOrgCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  });

  afterEach(() => SignupRegistry._reset());

  test('no resolver registered → personal workspace (today behaviour)', async () => {
    const result = await OrganizationsService.handleSignupOrganization(user);
    expect(mockOrgCreate).toHaveBeenCalledTimes(1);
    expect(mockOrgGet).not.toHaveBeenCalled();
    expect(result.joined).toBeUndefined();
    expect(result.organization).toBeTruthy();
    expect(emitted('organization.created')).toHaveLength(1);
  });

  test('a resolver that answers nothing → personal workspace', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => null);
    await OrganizationsService.handleSignupOrganization(user);
    expect(mockOrgCreate).toHaveBeenCalledTimes(1);
  });

  test('the signup context reaches the resolvers as is', async () => {
    const resolver = jest.fn(async () => null);
    SignupRegistry.registerSignupMembershipResolver(resolver);
    await OrganizationsService.handleSignupOrganization(user, { inviteId: 'inv-1' });
    expect(resolver).toHaveBeenCalledWith(user, { inviteId: 'inv-1' });
  });

  test('resolved org → ACTIVE membership with role + addedBy, current org set, A4 converges, no new org', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => ({ organizationId: invitedOrg._id, role: 'admin', invitedBy: inviterId }));
    const joined = { _id: new mongoose.Types.ObjectId(), organizationId: invitedOrg, role: 'admin', status: 'active' };
    // 1st findOne: the (user, org) existence check → none; 2nd: the A4 active-membership guard.
    mockMembershipFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(joined);

    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(mockMembershipCreate).toHaveBeenCalledWith({
      userId: user.id,
      organizationId: invitedOrg._id,
      role: 'admin',
      status: 'active',
      addedBy: inviterId,
    });
    expect(mockUpdateById).toHaveBeenCalledWith(user.id, { currentOrganization: invitedOrg._id });
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(emitted('organization.created')).toHaveLength(0);
    expect(result.organization).toBe(invitedOrg);
    expect(result.joined).toBe(true);
    expect(result.membership).toBe(joined);
  });

  test('resolved without a role → member', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => ({ organizationId: invitedOrg._id }));
    mockMembershipFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ organizationId: invitedOrg });
    await OrganizationsService.handleSignupOrganization(user);
    expect(mockMembershipCreate).toHaveBeenCalledWith(expect.objectContaining({ role: 'member', addedBy: null }));
  });

  test('the resolved organization no longer exists → personal workspace, no crash', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => ({ organizationId: invitedOrg._id, role: 'member' }));
    mockOrgGet.mockResolvedValue(null);
    const result = await OrganizationsService.handleSignupOrganization(user);
    expect(mockOrgCreate).toHaveBeenCalledTimes(1);
    expect(mockMembershipCreate).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }));
    expect(result.organization).toBeTruthy();
  });

  test('a membership row already exists for (user, org) → no second row', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => ({ organizationId: invitedOrg._id, role: 'member' }));
    const existing = { _id: new mongoose.Types.ObjectId(), organizationId: invitedOrg, status: 'active' };
    mockMembershipFindOne.mockResolvedValue(existing);
    const result = await OrganizationsService.handleSignupOrganization(user);
    expect(mockMembershipCreate).not.toHaveBeenCalled();
    expect(result.membership).toBe(existing);
  });

  test('current-organization write fails → membership rolled back, error propagates', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => ({ organizationId: invitedOrg._id, role: 'member' }));
    mockUpdateById.mockRejectedValue(new Error('db down'));
    await expect(OrganizationsService.handleSignupOrganization(user)).rejects.toThrow('db down');
    const created = await mockMembershipCreate.mock.results[0].value;
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith({ _id: created._id });
  });

  test('a resolver error propagates (signup rolls back, the invite is released)', async () => {
    SignupRegistry.registerSignupMembershipResolver(async () => { throw new Error('resolver down'); });
    await expect(OrganizationsService.handleSignupOrganization(user)).rejects.toThrow('resolver down');
    expect(mockOrgCreate).not.toHaveBeenCalled();
  });

  test('strict verification + mailer + unverified → resolvers not asked (the join waits for verifyEmail)', async () => {
    const resolver = jest.fn();
    SignupRegistry.registerSignupMembershipResolver(resolver);
    mockIsConfigured.mockReturnValue(true);
    const result = await OrganizationsService.handleSignupOrganization({ ...user, emailVerified: false });
    expect(resolver).not.toHaveBeenCalled();
    expect(result.emailVerificationRequired).toBe(true);
  });

  test('registry rejects a non-function and de-dupes the same resolver', async () => {
    expect(() => SignupRegistry.registerSignupMembershipResolver('nope')).toThrow(TypeError);
    const resolver = jest.fn().mockResolvedValue(null);
    SignupRegistry.registerSignupMembershipResolver(resolver);
    SignupRegistry.registerSignupMembershipResolver(resolver);
    await SignupRegistry.resolveSignupMembership(user);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
