/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect, jest } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';
import mails from '../../../lib/helpers/mailer/index.js';

/**
 * Organization-targeted invitations — real HTTP routes, real DB.
 *
 * `/api/organizations/:organizationId/invitations[/:invitationId[/resend]]`: an owner or
 * admin of the org (or a platform admin) invites an email INTO the org with a role, and
 * any owner/admin lists / resends / revokes the org's pending invites. Covers the rights
 * matrix, the role ceiling, org scoping (another org's invite → 404), the platform
 * guards (E9, one live invite per email), the verify org name, the Referrals list
 * exclusion, the org-removal revoke, and the referral skip on accept.
 */
describe('Organization invitations:', () => {
  let app;
  let UserService;
  let MembershipRepository;
  let OrganizationsRepository;
  let BillingExtraBalanceRepository;
  let Invitation;

  const password = 'W@os.jsI$Aw3$0m3';
  const suffix = Date.now();
  const email = (name) => `orginv-${name}-${suffix}@test.com`;

  const savedOrganizations = { ...config.organizations };
  const savedUp = config.sign.up;
  const savedCap = config.sign.cap;
  const savedInvitations = { ...config.invitations };
  const savedReferral = config.billing?.referral;

  const users = {};
  const agents = {};
  let orgA;
  let orgB;
  const createdOrgIds = [];

  /**
   * Sign a user up (own organization, signup open) and keep an authenticated agent.
   * @param {string} name - Fixture key.
   * @returns {Promise<void>}
   */
  const signup = async (name) => {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/signup')
      .send({ firstName: name, lastName: 'Tester', email: email(name), password, provider: 'local' })
      .expect(200);
    users[name] = res.body.user;
    agents[name] = agent;
    if (res.body.organization) createdOrgIds.push(res.body.organization.id || res.body.organization._id);
    return res.body.organization;
  };

  const orgPath = (org, rest = '') => `/api/organizations/${org.id || org._id}/invitations${rest}`;

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    MembershipRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.membership.repository.js'))).default;
    OrganizationsRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.repository.js'))).default;
    BillingExtraBalanceRepository = (await import(path.resolve('./modules/billing/repositories/billing.extraBalance.repository.js'))).default;
    Invitation = mongoose.model('Invitation');

    config.organizations = { ...savedOrganizations, enabled: true, domainMatching: false };
    config.sign.up = true;
    config.sign.cap = null;

    orgA = await signup('owner');
    await signup('admin');
    await signup('member');
    orgB = await signup('outsider');
    await signup('platform');

    const orgAId = orgA.id || orgA._id;
    await MembershipRepository.create({ userId: users.admin.id, organizationId: orgAId, role: 'admin', status: 'active' });
    await MembershipRepository.create({ userId: users.member.id, organizationId: orgAId, role: 'member', status: 'active' });

    const brut = await UserService.getBrut({ id: users.platform.id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');
    await agents.platform.post('/api/auth/signin').send({ email: email('platform'), password }).expect(200);

    // The resend IS the email: pretend a mailer is configured, never send for real. Set
    // AFTER the fixture signups — a configured mailer defers org provisioning at signup.
    jest.spyOn(mails, 'isConfigured').mockReturnValue(true);
    jest.spyOn(mails, 'sendMail').mockResolvedValue({});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    config.organizations = savedOrganizations;
    config.sign.up = savedUp;
    config.sign.cap = savedCap;
    config.invitations = savedInvitations;
    if (config.billing) config.billing.referral = savedReferral;
    try {
      await Invitation.deleteMany({ email: { $regex: `-${suffix}@` } });
      for (const orgId of createdOrgIds) {
        await MembershipRepository.deleteMany({ organizationId: orgId });
        await OrganizationsRepository.deleteMany({ _id: orgId });
      }
      for (const key of [...Object.keys(users), 'guest']) {
        const u = await UserService.getBrut({ email: email(key) });
        if (u) {
          await MembershipRepository.deleteMany({ userId: u._id });
          await UserService.remove(u);
        }
      }
    } catch (_) { /* cleanup */ }
  });

  // Each test creates the invitation it needs (own email) so it runs alone and in any order.
  const createInvite = async (key, agent = agents.owner) => {
    await agent.post(orgPath(orgA)).send({ email: email(key) }).expect(200);
    return Invitation.findOne({ email: email(key) });
  };

  describe('rights matrix', () => {
    test('owner invites an email into the org (default member, no token returned)', async () => {
      const res = await agents.owner.post(orgPath(orgA)).send({ email: email('inv1') });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ email: email('inv1'), role: 'member', status: 'pending' });
      expect(String(res.body.data.organizationId)).toBe(String(orgA.id || orgA._id));
      expect(res.body.data.token).toBeUndefined();
    });

    test('org admin can invite a member', async () => {
      const res = await agents.admin.post(orgPath(orgA)).send({ email: email('inv2') });
      expect(res.status).toBe(200);
    });

    test('plain member cannot list or invite → 403', async () => {
      expect((await agents.member.post(orgPath(orgA)).send({ email: email('nope1') })).status).toBe(403);
      expect((await agents.member.get(orgPath(orgA))).status).toBe(403);
    });

    test('a user of another org cannot list or invite → 403', async () => {
      expect((await agents.outsider.post(orgPath(orgA)).send({ email: email('nope2') })).status).toBe(403);
      expect((await agents.outsider.get(orgPath(orgA))).status).toBe(403);
    });

    test('platform admin (no membership) can invite, even an owner', async () => {
      const res = await agents.platform.post(orgPath(orgA)).send({ email: email('inv3'), role: 'owner' });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('owner');
    });

    test('unknown organization → 404', async () => {
      const res = await agents.owner.get(`/api/organizations/${new mongoose.Types.ObjectId()}/invitations`);
      expect(res.status).toBe(404);
    });
  });

  describe('role ceiling (same rule as add member)', () => {
    test('an org admin cannot invite an admin → 403', async () => {
      const res = await agents.admin.post(orgPath(orgA)).send({ email: email('nope3'), role: 'admin' });
      expect(res.status).toBe(403);
    });

    test('an owner can invite an admin', async () => {
      const res = await agents.owner.post(orgPath(orgA)).send({ email: email('inv4'), role: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('admin');
    });

    test('an unknown role is rejected by validation', async () => {
      const res = await agents.owner.post(orgPath(orgA)).send({ email: email('nope4'), role: 'superuser' });
      expect(res.status).toBe(422);
    });
  });

  describe('create guards (shared with platform invites)', () => {
    test('an already-registered email → 422 (E9)', async () => {
      const res = await agents.owner.post(orgPath(orgA)).send({ email: email('member') });
      expect(res.status).toBe(422);
    });

    test('one live invite per email platform-wide → 409, even from another org', async () => {
      await createInvite('dup1');
      const res = await agents.outsider.post(orgPath(orgB)).send({ email: email('dup1') });
      expect(res.status).toBe(409);
    });

    test('self-invite → 422', async () => {
      const res = await agents.owner.post(orgPath(orgA)).send({ email: email('owner') });
      expect(res.status).toBe(422);
    });
  });

  describe('list / resend / revoke by any owner or admin', () => {
    test('an org admin lists every pending invite of the org, tokens stripped, no other org', async () => {
      await createInvite('ls1');
      await agents.outsider.post(orgPath(orgB)).send({ email: email('b1') }).expect(200);
      const res = await agents.admin.get(orgPath(orgA));
      expect(res.status).toBe(200);
      const emails = res.body.data.map((i) => i.email);
      expect(emails).toEqual(expect.arrayContaining([email('ls1')]));
      expect(emails).not.toContain(email('b1'));
      expect(res.body.data.every((i) => i.token === undefined)).toBe(true);
    });

    test('a second org admin resends the owner\'s invite (org-invite email, existing token)', async () => {
      const invite = await createInvite('rs1');
      mails.sendMail.mockClear();
      const res = await agents.admin.post(orgPath(orgA, `/${invite.id}/resend`));
      expect(res.status).toBe(200);
      expect(res.body.data.token).toBeUndefined();
      expect(mails.sendMail).toHaveBeenCalledWith(expect.objectContaining({
        template: 'org-invite',
        to: email('rs1'),
        params: expect.objectContaining({ orgName: orgA.name, url: expect.stringContaining(`inviteToken=${invite.token}`) }),
      }));
    });

    test('another org\'s invitation (or a platform invite) through this org → 404', async () => {
      await agents.outsider.post(orgPath(orgB)).send({ email: email('b1') });
      const other = await Invitation.findOne({ email: email('b1') });
      expect((await agents.owner.delete(orgPath(orgA, `/${other.id}`))).status).toBe(404);
      expect((await agents.owner.post(orgPath(orgA, `/${other.id}/resend`))).status).toBe(404);
      const platform = await agents.platform.post('/api/invitations').send({ email: email('plat1') }).expect(200);
      expect((await agents.owner.delete(orgPath(orgA, `/${platform.body.data.id}`))).status).toBe(404);
    });

    test('a second org admin revokes the owner\'s invite; revoking again → 409', async () => {
      const invite = await createInvite('rv1');
      expect((await agents.admin.delete(orgPath(orgA, `/${invite.id}`))).status).toBe(200);
      expect((await Invitation.findById(invite.id)).status).toBe('revoked');
      expect((await agents.admin.delete(orgPath(orgA, `/${invite.id}`))).status).toBe(409);
    });

    test('a plain member cannot revoke or resend → 403', async () => {
      const invite = await createInvite('mv1');
      expect((await agents.member.delete(orgPath(orgA, `/${invite.id}`))).status).toBe(403);
      expect((await agents.member.post(orgPath(orgA, `/${invite.id}/resend`))).status).toBe(403);
    });
  });

  describe('verify + referrals list', () => {
    test('public verify returns the org name (name only) for an org invite', async () => {
      const invite = await createInvite('vf1');
      const res = await request(app).get(`/api/invitations/verify/${invite.token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ valid: true, email: email('vf1'), organization: { name: orgA.name } });
    });

    test('the user-facing Referrals list never shows org invites', async () => {
      config.invitations = { ...config.invitations, userFacing: true };
      try {
        await createInvite('ref1-org');
        await agents.owner.post('/api/invitations').send({ email: email('ref1') }).expect(200);
        const res = await agents.owner.get('/api/invitations');
        expect(res.status).toBe(200);
        const emails = res.body.data.map((i) => i.email);
        expect(emails).toContain(email('ref1'));
        expect(emails).not.toContain(email('ref1-org'));
      } finally {
        config.invitations = { ...savedInvitations };
      }
    });
  });

  describe('referral skip on accept', () => {
    test('signing up through an org invite stamps no referredBy and credits no referral', async () => {
      config.billing = config.billing || {};
      config.billing.referral = { enabled: true, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 };
      const created = await agents.owner.post(orgPath(orgA)).send({ email: email('guest') }).expect(200);
      const invite = await Invitation.findById(created.body.data.id);

      config.sign.up = false;
      try {
        const res = await request(app)
          .post(`/api/auth/signup?inviteToken=${invite.token}`)
          .send({ email: email('guest'), password: 'Sup3rStr0ng!' });
        expect(res.status).toBe(200);
      } finally {
        config.sign.up = true;
      }

      const guest = await UserService.getBrut({ email: email('guest') });
      if (guest.currentOrganization) createdOrgIds.push(guest.currentOrganization._id || guest.currentOrganization);
      expect(guest.referredBy ?? null).toBeNull();
      expect((await Invitation.findById(invite.id)).status).toBe('accepted');

      await new Promise((resolve) => { setTimeout(resolve, 500); });
      const keys = [`referral:${invite.id}:referee`, `referral:${invite.id}:referrer`];
      expect(await BillingExtraBalanceRepository.findExistingRefIds(keys)).toEqual([]);
    });
  });

  describe('organization removal', () => {
    test('removing the org revokes its pending invites (accepted / other orgs untouched)', async () => {
      const pendingB = await Invitation.findOne({ email: email('b1') });
      const pendingA = await Invitation.findOne({ email: email('inv2') });
      // Platform admin removes it (a user may not delete their own last organization).
      const res = await agents.platform.delete(`/api/organizations/${orgB.id || orgB._id}`);
      expect(res.status).toBe(200);
      expect((await Invitation.findById(pendingB.id)).status).toBe('revoked');
      expect((await Invitation.findById(pendingA.id)).status).toBe('pending');
    });
  });
});
