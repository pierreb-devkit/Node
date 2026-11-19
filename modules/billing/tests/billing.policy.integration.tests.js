/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';

/**
 * Billing policy integration tests — through the real auth, organization and policy
 * middlewares. Only organization owners and admins can start a plan checkout, an
 * extras checkout or open the Stripe portal; a plain member gets 403 on all three
 * and keeps read access. The abilities sent to the client say the same thing.
 *
 * Owner/admin requests send a body the route validator rejects (unknown key): a 422
 * proves the policy let the request through without reaching Stripe.
 */
describe('Billing policy — owner/admin only pay routes:', () => {
  let app;
  let UserService;
  let MembershipService;
  let MembershipRepository;
  let OrganizationsRepository;

  const PASSWORD = 'W@os.jsI$Aw3$0m3';
  const EMAILS = {
    owner: 'billing-policy-owner@test.com',
    admin: 'billing-policy-admin@test.com',
    member: 'billing-policy-member@test.com',
  };
  const PAY_ROUTES = ['/api/billing/checkout', '/api/billing/portal', '/api/billing/extras/checkout'];
  const PAY_SUBJECTS = ['BillingCheckout', 'BillingPortal', 'BillingExtrasCheckout'];
  const originalOrganizations = { ...config.organizations };

  const agents = {};
  const users = {};
  const signupAbilities = {};
  const switchAbilities = {};
  let orgId;

  /**
   * @param {Array<Object>} abilities - serialized CASL rules
   * @param {string} subject - CASL subject
   * @returns {boolean} true when a `create` rule exists for the subject
   */
  const hasCreate = (abilities, subject) => abilities.some((r) => r.action === 'create' && r.subject === subject && !r.inverted);

  /**
   * Remove a user, their memberships and the organizations they own.
   * @param {string} email - user email
   * @returns {Promise<void>}
   */
  const cleanup = async (email) => {
    try {
      const existing = await UserService.getBrut({ email });
      if (!existing) return;
      const memberships = await MembershipRepository.list({ userId: existing._id });
      for (const m of memberships) {
        if (m.role !== 'owner') continue;
        const id = m.organizationId._id || m.organizationId;
        await MembershipRepository.deleteMany({ organizationId: id });
        await OrganizationsRepository.deleteMany({ _id: id });
      }
      await MembershipRepository.deleteMany({ userId: existing._id });
      await UserService.remove(existing);
    } catch (_) { /* cleanup — ignore */ }
  };

  beforeAll(async () => {
    config.organizations = { ...config.organizations, enabled: true, domainMatching: false };
    app = (await bootstrap()).app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    MembershipService = (await import(path.resolve('./modules/organizations/services/organizations.membership.service.js'))).default;
    MembershipRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.membership.repository.js'))).default;
    OrganizationsRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.repository.js'))).default;

    for (const email of Object.values(EMAILS)) await cleanup(email);

    for (const [key, email] of Object.entries(EMAILS)) {
      agents[key] = request.agent(app);
      const res = await agents[key]
        .post('/api/auth/signup')
        .send({ firstName: 'Billing', lastName: key, email, password: PASSWORD, provider: 'local' })
        .expect(200);
      users[key] = res.body.user;
      signupAbilities[key] = res.body.abilities;
    }

    orgId = String(users.owner.currentOrganization);
    await MembershipService.create({ userId: users.admin.id || users.admin._id, organizationId: orgId, role: 'admin' });
    await MembershipService.create({ userId: users.member.id || users.member._id, organizationId: orgId, role: 'member' });

    // Billing routes act on the caller's current organization: move admin and member into the owner's.
    for (const key of ['admin', 'member']) {
      const res = await agents[key].post(`/api/organizations/${orgId}/switch`).expect(200);
      switchAbilities[key] = res.body.data.abilities;
    }
  });

  afterAll(async () => {
    for (const email of Object.values(EMAILS)) await cleanup(email);
    config.organizations = originalOrganizations;
  });

  describe('pay routes', () => {
    test.each(PAY_ROUTES)('member gets 403 from the policy on POST %s', async (route) => {
      const res = await agents.member.post(route).send({ bogus: true });
      expect(res.status).toBe(403);
      expect(res.body.description).toBe('User is not authorized');
    });

    test.each(PAY_ROUTES)('owner passes the policy on POST %s', async (route) => {
      const res = await agents.owner.post(route).send({ bogus: true });
      expect(res.status).toBe(422);
    });

    test.each(PAY_ROUTES)('admin passes the policy on POST %s', async (route) => {
      const res = await agents.admin.post(route).send({ bogus: true });
      expect(res.status).toBe(422);
    });
  });

  describe('member read routes stay open', () => {
    test.each(['/api/billing/subscription', '/api/billing/usage', '/api/billing/extras/balance', '/api/billing/extras/ledger'])(
      'member is not refused by the policy on GET %s',
      async (route) => {
        const res = await agents.member.get(route);
        expect(res.status).toBe(200);
        expect(res.body.type).toBe('success');
      },
    );
  });

  describe('abilities sent to the client', () => {
    test.each(PAY_SUBJECTS)('owner signup response grants create %s', (subject) => {
      expect(hasCreate(signupAbilities.owner, subject)).toBe(true);
    });

    test.each(PAY_SUBJECTS)('admin switch response grants create %s', (subject) => {
      expect(hasCreate(switchAbilities.admin, subject)).toBe(true);
    });

    test.each(PAY_SUBJECTS)('member switch response does not grant create %s', (subject) => {
      expect(hasCreate(switchAbilities.member, subject)).toBe(false);
    });

    test('token refresh: owner has the pay rights, member has none', async () => {
      const owner = (await agents.owner.get('/api/auth/token').expect(200)).body.abilities;
      const member = (await agents.member.get('/api/auth/token').expect(200)).body.abilities;
      for (const subject of PAY_SUBJECTS) {
        expect(hasCreate(owner, subject)).toBe(true);
        expect(hasCreate(member, subject)).toBe(false);
      }
      expect(member.some((r) => r.action === 'read' && r.subject === 'BillingSubscription')).toBe(true);
    });

    test('signin: member signed back in keeps no pay rights', async () => {
      const res = await agents.member.post('/api/auth/signin').send({ email: EMAILS.member, password: PASSWORD }).expect(200);
      for (const subject of PAY_SUBJECTS) expect(hasCreate(res.body.abilities, subject)).toBe(false);
    });
  });
});
