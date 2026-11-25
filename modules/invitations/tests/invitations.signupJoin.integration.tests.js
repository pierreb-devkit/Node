/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import mongoose from 'mongoose';

import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';
import mails from '../../../lib/helpers/mailer/index.js';

/**
 * Signup join — real HTTP routes, real DB.
 *
 * A person signing up through an ORGANIZATION invitation joins that organization with the
 * invited role: no personal workspace, no signup grant (no org created by them), current
 * organization = the org. Matrix: local token × {verification off, strict + mailer (join at
 * verifyEmail)}, open vs closed signup, OAuth by provider-verified email, revoked / expired /
 * already-claimed token, org removed before the join. The platform (no-org) invite is unchanged.
 */
describe('Invitations signup join:', () => {
  let app;
  let UserService;
  let MembershipRepository;
  let OrganizationsRepository;
  let InvitationsService;
  let InvitationRepository;
  let OrganizationsService;
  let AuthController;
  let Invitation;

  const password = 'W@os.jsI$Aw3$0m3';
  const suffix = Date.now();
  const email = (name) => `sjoin-${name}-${suffix}@test.com`;

  const savedOrganizations = { ...config.organizations };
  const savedUp = config.sign.up;
  const savedCap = config.sign.cap;
  const savedInvitations = { ...config.invitations };

  let owner;
  let ownerAgent;
  let org;
  let orgId;
  const createdOrgIds = [];
  const userKeys = new Set();

  /**
   * @desc Local signup through the HTTP route, optionally with an invite token.
   * @param {string} key - fixture key (email local part)
   * @param {string} [token] - invite token, sent as `?inviteToken=`
   * @returns {Promise<Object>} supertest response
   */
  const signup = (key, token) => {
    userKeys.add(key);
    return request(app)
      .post(`/api/auth/signup${token ? `?inviteToken=${token}` : ''}`)
      .send({ firstName: key, lastName: 'Tester', email: email(key), password, provider: 'local' });
  };

  /**
   * @desc Create an org invitation for `key` (as the org owner) and read its token from the DB.
   * @param {string} key - fixture key
   * @param {string} [role] - invited role
   * @returns {Promise<Object>} the invitation document (with token)
   */
  const invite = async (key, role) => {
    await ownerAgent.post(`/api/organizations/${orgId}/invitations`).send({ email: email(key), ...(role ? { role } : {}) }).expect(200);
    return Invitation.findOne({ email: email(key) });
  };

  /**
   * @desc Assert the user joined the invited org: one ACTIVE membership in it with `role`,
   * current organization = org, and no organization created by them (no personal workspace,
   * so no signup grant).
   * @param {string} key - fixture key
   * @param {string} role - expected role
   * @returns {Promise<Object>} the user (brut)
   */
  const expectJoined = async (key, role) => {
    const user = await UserService.getBrut({ email: email(key) });
    const memberships = await MembershipRepository.list({ userId: user._id });
    expect(memberships).toHaveLength(1);
    expect(String(memberships[0].organizationId._id || memberships[0].organizationId)).toBe(String(orgId));
    expect(memberships[0]).toMatchObject({ role, status: 'active' });
    expect(String(memberships[0].addedBy?._id || memberships[0].addedBy)).toBe(String(owner.id));
    expect(String(user.currentOrganization)).toBe(String(orgId));
    expect(await OrganizationsRepository.list({ createdBy: user._id })).toHaveLength(0);
    return user;
  };

  /**
   * @desc Assert the user got a personal workspace (owner of an org they created), not the invited org.
   * @param {string} key - fixture key
   * @returns {Promise<void>}
   */
  const expectPersonalWorkspace = async (key) => {
    const user = await UserService.getBrut({ email: email(key) });
    const memberships = await MembershipRepository.list({ userId: user._id });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
    const ownOrgId = String(memberships[0].organizationId._id || memberships[0].organizationId);
    expect(ownOrgId).not.toBe(String(orgId));
    expect(String(user.currentOrganization)).toBe(ownOrgId);
    createdOrgIds.push(ownOrgId);
  };

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    MembershipRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.membership.repository.js'))).default;
    OrganizationsRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.repository.js'))).default;
    OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.service.js'))).default;
    InvitationsService = (await import(path.resolve('./modules/invitations/services/invitations.service.js'))).default;
    InvitationRepository = (await import(path.resolve('./modules/invitations/repositories/invitations.repository.js'))).default;
    AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
    Invitation = mongoose.model('Invitation');

    config.organizations = { ...savedOrganizations, enabled: true, domainMatching: false, emailVerification: { mode: 'strict' } };
    config.sign.up = true;
    config.sign.cap = null;
    config.invitations = { ...savedInvitations, userFacing: false };

    const mailerSpy = jest.spyOn(mails, 'isConfigured').mockReturnValue(false);
    ownerAgent = request.agent(app);
    userKeys.add('owner');
    const res = await ownerAgent
      .post('/api/auth/signup')
      .send({ firstName: 'owner', lastName: 'Tester', email: email('owner'), password, provider: 'local' })
      .expect(200);
    mailerSpy.mockRestore();
    owner = res.body.user;
    org = res.body.organization;
    orgId = org.id || org._id;
    createdOrgIds.push(orgId);
  });

  beforeEach(() => {
    config.sign.up = true;
    config.organizations.emailVerification = { mode: 'strict' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    config.organizations = savedOrganizations;
    config.sign.up = savedUp;
    config.sign.cap = savedCap;
    config.invitations = savedInvitations;
    try {
      await Invitation.deleteMany({ email: { $regex: `-${suffix}@` } });
      for (const id of createdOrgIds) {
        await MembershipRepository.deleteMany({ organizationId: id });
        await OrganizationsRepository.deleteMany({ _id: id });
      }
      for (const key of userKeys) {
        const u = await UserService.getBrut({ email: email(key) });
        if (u) {
          await MembershipRepository.deleteMany({ userId: u._id });
          await OrganizationsRepository.deleteMany({ createdBy: u._id });
          await UserService.remove(u);
        }
      }
    } catch (_) { /* cleanup */ }
  });

  describe('local signup, verification off (no mailer)', () => {
    test('closed signup + org token → joins the org with the invited role, invite accepted', async () => {
      const inv = await invite('closed', 'admin');
      config.sign.up = false;
      const res = await signup('closed', inv.token);
      expect(res.status).toBe(200);
      expect(String(res.body.organization._id || res.body.organization.id)).toBe(String(orgId));
      expect(res.body.joined).toBe(true);
      expect(res.body.user.currentOrganization).toBeDefined();
      const user = await expectJoined('closed', 'admin');
      const after = await Invitation.findById(inv._id);
      expect(after.status).toBe('accepted');
      expect(String(after.acceptedUserId)).toBe(String(user._id));
      expect(user.referredBy ?? null).toBeNull();
    });

    test('open signup + org token (userFacing off) → the token is still claimed and the user joins', async () => {
      const inv = await invite('open', 'member');
      const res = await signup('open', inv.token);
      expect(res.status).toBe(200);
      await expectJoined('open', 'member');
      expect((await Invitation.findById(inv._id)).status).toBe('accepted');
    });

    test('open signup with the invited email but NO token → personal workspace, invite stays pending', async () => {
      const inv = await invite('notoken');
      const res = await signup('notoken');
      expect(res.status).toBe(200);
      expect(res.body.joined).toBe(false);
      await expectPersonalWorkspace('notoken');
      expect((await Invitation.findById(inv._id)).status).toBe('pending');
    });

    test('a claim left in flight on the email (stale, or another request) never joins a no-token signup', async () => {
      const inv = await invite('foreignclaim', 'admin');
      await InvitationRepository.claim(inv.token);
      const res = await signup('foreignclaim');
      expect(res.status).toBe(200);
      await expectPersonalWorkspace('foreignclaim');
      const after = await Invitation.findById(inv._id);
      expect(after.status).toBe('pending');
      expect(after.acceptedUserId ?? null).toBeNull();
    });

    test('provisioning fails after the join → account and membership rolled back, claim released', async () => {
      const inv = await invite('joinfail', 'admin');
      const membersBefore = (await MembershipRepository.list({ organizationId: orgId })).length;
      jest.spyOn(UserService, 'updateById').mockRejectedValueOnce(new Error('boom'));
      const res = await signup('joinfail', inv.token);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await UserService.getBrut({ email: email('joinfail') })).toBeFalsy();
      expect(await MembershipRepository.list({ organizationId: orgId })).toHaveLength(membersBefore);
      const after = await Invitation.findById(inv._id);
      expect(after.status).toBe('pending');
      expect(after.consumingAt ?? null).toBeNull();
    });
  });

  describe('local signup, strict verification + mailer', () => {
    beforeEach(() => {
      jest.spyOn(mails, 'isConfigured').mockReturnValue(true);
      jest.spyOn(mails, 'sendMail').mockResolvedValue({ accepted: ['x'] });
    });

    test('nothing joins at signup (never auto-verified); the join happens at verifyEmail', async () => {
      const inv = await invite('strict', 'admin');
      config.sign.up = false;
      const res = await signup('strict', inv.token);
      expect(res.status).toBe(200);
      expect(res.body.organization).toBeNull();
      expect(res.body.emailVerificationRequired).toBe(true);
      let user = await UserService.getBrut({ email: email('strict') });
      expect(user.emailVerified).toBe(false);
      expect(await MembershipRepository.list({ userId: user._id })).toHaveLength(0);
      expect((await Invitation.findById(inv._id)).status).toBe('accepted');

      await request(app).post(`/api/auth/verify-email/${user.emailVerificationToken}`).expect(200);
      user = await expectJoined('strict', 'admin');
      expect(user.emailVerified).toBe(true);
    });

    test('verification mode off + mailer → joins at signup, still not auto-verified', async () => {
      config.organizations.emailVerification = { mode: 'off' };
      const inv = await invite('modeoff');
      const res = await signup('modeoff', inv.token);
      expect(res.status).toBe(200);
      const user = await expectJoined('modeoff', 'member');
      expect(user.emailVerified).toBe(false);
    });

    test('invite revoked while the signup runs (finalize lands nothing) → signup fails, no account, no membership', async () => {
      config.organizations.emailVerification = { mode: 'off' };
      const inv = await invite('revoking');
      jest.spyOn(InvitationRepository, 'finalize').mockResolvedValue(null);
      const res = await signup('revoking', inv.token);
      expect(res.status).toBe(403);
      expect(await UserService.getBrut({ email: email('revoking') })).toBeFalsy();
      const members = await MembershipRepository.list({ organizationId: orgId });
      expect(members.some((m) => m.userId?.email === email('revoking'))).toBe(false);
    });

    test('org removed between signup and verifyEmail → personal workspace at verification, no crash', async () => {
      const ownerB = await UserService.getBrut({ email: email('owner') });
      const tmpOrg = await OrganizationsRepository.create({ name: 'Temp', slug: `temp-${suffix}`, domain: '', plan: 'free', createdBy: ownerB._id });
      createdOrgIds.push(String(tmpOrg._id));
      await MembershipRepository.create({ userId: ownerB._id, organizationId: tmpOrg._id, role: 'owner', status: 'active' });
      await ownerAgent.post(`/api/organizations/${tmpOrg._id}/invitations`).send({ email: email('orggone') }).expect(200);
      const inv = await Invitation.findOne({ email: email('orggone') });

      const res = await signup('orggone', inv.token);
      expect(res.status).toBe(200);
      await OrganizationsRepository.deleteMany({ _id: tmpOrg._id });
      await MembershipRepository.deleteMany({ organizationId: tmpOrg._id });

      const user = await UserService.getBrut({ email: email('orggone') });
      await request(app).post(`/api/auth/verify-email/${user.emailVerificationToken}`).expect(200);
      await expectPersonalWorkspace('orggone');
    });
  });

  describe('token states (closed signup)', () => {
    beforeEach(() => { config.sign.up = false; });

    test('revoked token → signup refused (404), no account', async () => {
      const inv = await invite('revoked');
      await ownerAgent.delete(`/api/organizations/${orgId}/invitations/${inv._id}`).expect(200);
      const res = await signup('revoked', inv.token);
      expect(res.status).toBe(404);
      expect(await UserService.getBrut({ email: email('revoked') })).toBeFalsy();
    });

    test('expired token → signup refused (404)', async () => {
      const inv = await invite('expired');
      await Invitation.updateOne({ _id: inv._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await signup('expired', inv.token);
      expect(res.status).toBe(404);
    });

    test('already-claimed token (in flight elsewhere) → signup refused, no account', async () => {
      const inv = await invite('claimed');
      await InvitationRepository.claim(inv.token);
      const res = await signup('claimed', inv.token);
      expect(res.status).toBe(404);
      expect(await UserService.getBrut({ email: email('claimed') })).toBeFalsy();
    });

    test('revoked open signup token → personal workspace (the token simply no longer counts)', async () => {
      config.sign.up = true;
      const inv = await invite('revokedopen');
      await ownerAgent.delete(`/api/organizations/${orgId}/invitations/${inv._id}`).expect(200);
      const res = await signup('revokedopen', inv.token);
      expect(res.status).toBe(200);
      await expectPersonalWorkspace('revokedopen');
    });
  });

  describe('resolver edges', () => {
    test('invite revoked between claim and join → nothing to join', async () => {
      const inv = await invite('midrevoke');
      await InvitationRepository.claim(inv.token);
      const fakeUser = { id: String(new mongoose.Types.ObjectId()), email: email('midrevoke') };
      const ctx = { inviteId: String(inv._id) };
      expect(await InvitationsService.resolveSignupMembership(fakeUser, ctx)).toMatchObject({ role: 'member' });
      await InvitationsService.revokeForOrganization(String(orgId));
      expect(await InvitationsService.resolveSignupMembership(fakeUser, ctx)).toBeNull();
    });

    test('a claimed invite resolves only for the signup that claimed it (its id), never by email alone', async () => {
      const inv = await invite('claimbound');
      await InvitationRepository.claim(inv.token);
      const fakeUser = { id: String(new mongoose.Types.ObjectId()), email: email('claimbound') };
      expect(await InvitationsService.resolveSignupMembership(fakeUser)).toBeNull();
      expect(await InvitationsService.resolveSignupMembership(fakeUser, { inviteId: String(new mongoose.Types.ObjectId()) })).toBeNull();
      expect(await InvitationsService.resolveSignupMembership(fakeUser, { inviteId: String(inv._id) })).toMatchObject({ role: 'member' });
    });

    test('an unclaimed pending invite for the email never resolves', async () => {
      await invite('unclaimed');
      const fakeUser = { id: String(new mongoose.Types.ObjectId()), email: email('unclaimed') };
      expect(await InvitationsService.resolveSignupMembership(fakeUser)).toBeNull();
    });
  });

  describe('OAuth, by provider-verified email', () => {
    /**
     * @desc Run the OAuth new-user path the way oauthCallback does: profile check, then provisioning.
     * @param {string} key - fixture key
     * @returns {Promise<Object>} the created user
     */
    const oauthSignup = async (key) => {
      userKeys.add(key);
      const created = await AuthController.checkOAuthUserProfile({
        firstName: key,
        lastName: 'OAuth',
        email: email(key),
        avatar: '',
        providerData: { sub: `google-sjoin-${key}-${suffix}` },
        emailVerifiedByProvider: true,
      }, 'sub', 'google');
      await OrganizationsService.handleSignupOrganization(created);
      return created;
    };

    test('closed signup → joins the org with the invited role', async () => {
      const inv = await invite('oauthclosed', 'admin');
      config.sign.up = false;
      await oauthSignup('oauthclosed');
      await expectJoined('oauthclosed', 'admin');
      expect((await Invitation.findById(inv._id)).status).toBe('accepted');
    });

    test('open signup → an org invite is honored too, the user joins', async () => {
      const inv = await invite('oauthopen');
      await oauthSignup('oauthopen');
      await expectJoined('oauthopen', 'member');
      expect((await Invitation.findById(inv._id)).status).toBe('accepted');
    });
  });

  describe('platform (no-org) invite unchanged', () => {
    test('closed signup + platform invite → personal workspace, referredBy = inviter', async () => {
      const platformAdmin = await UserService.getBrut({ email: email('owner') });
      await UserService.update(platformAdmin, { roles: ['user', 'admin'] }, 'admin');
      await ownerAgent.post('/api/auth/signin').send({ email: email('owner'), password }).expect(200);
      await ownerAgent.post('/api/invitations').send({ email: email('platform') }).expect(200);
      const inv = await Invitation.findOne({ email: email('platform') });
      expect(inv.organizationId ?? null).toBeNull();

      config.sign.up = false;
      const res = await signup('platform', inv.token);
      expect(res.status).toBe(200);
      await expectPersonalWorkspace('platform');
      const user = await UserService.getBrut({ email: email('platform') });
      expect(String(user.referredBy)).toBe(String(owner.id));
    });

    test('open signup + platform token, userFacing off → not claimed, stays pending', async () => {
      const inv = await InvitationRepository.create({
        email: email('platformopen'), token: `tok-${suffix}`, expiresAt: new Date(Date.now() + 3600000), invitedBy: owner.id,
      });
      const res = await signup('platformopen', inv.token);
      expect(res.status).toBe(200);
      await expectPersonalWorkspace('platformopen');
      const after = await Invitation.findById(inv._id);
      expect(after.status).toBe('pending');
      expect(after.consumingAt ?? null).toBeNull();
    });
  });
});
