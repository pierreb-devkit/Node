/**
 * @desc Security regression E2E: a non-member must NOT be able to self-join (or
 * inject any membership into) an organization via POST /:id/members.
 *
 * Mechanism guarded: the Organization document-subject was resolved before the
 * dedicated Membership path-subject on the /members route, so the unconditional
 * `create Organization` grant authorized the request for ANY authenticated user.
 * The members POST must instead authorize via the Membership subject (owner/admin
 * gate) — a non-member has no `create Membership` ability → 403, no row created.
 *
 * Also asserts the legitimate any-user JOIN-REQUEST flow (POST /:id/requests) is
 * unaffected — that flow LEGITIMATELY relies on the create-Organization grant.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations self-join authorization E2E tests:', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

  const password = 'W@os.jsI$Aw3$0m3';

  // Store original config
  const originalOrganizations = { ...config.organizations };

  /**
   * @description Reset organizations config to original state.
   */
  const resetOrgConfig = () => {
    config.organizations = { ...originalOrganizations };
  };

  /**
   * @description Clean up a user and their associated organizations/memberships.
   * @param {Object} user - The user object to clean up.
   * @returns {Promise<void>}
   */
  const cleanupUser = async (user) => {
    if (!user) return;
    try {
      const memberships = await MembershipRepository.list({ userId: user.id || user._id });
      for (const m of memberships) {
        const orgId = m.organizationId._id || m.organizationId;
        await MembershipRepository.deleteMany({ organizationId: orgId });
        await OrganizationsRepository.deleteMany({ _id: orgId });
      }
      await UserService.remove(user);
    } catch (_) { /* cleanup — ignore errors */ }
  };

  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      OrganizationsRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.repository.js'))).default;
      MembershipRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.membership.repository.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Non-member cannot self-join via POST /:id/members', () => {
    let owner;
    let outsider;
    let org;
    let agentOwner;
    let agentOutsider;

    // Unique-per-run emails to avoid dirty-DB re-run flakiness
    const suffix = Date.now();
    const emailOwner = `self-join-owner-${suffix}@test.com`;
    const emailOutsider = `self-join-outsider-${suffix}@test.com`;

    beforeAll(() => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
    });

    afterAll(async () => {
      resetOrgConfig();
      try {
        if (org) {
          await MembershipRepository.deleteMany({ organizationId: org._id });
          await OrganizationsRepository.deleteMany({ _id: org._id });
        }
      } catch (_) { /* cleanup */ }
      await cleanupUser(outsider);
      await cleanupUser(owner);
    });

    test('a non-member self-adding to an org is rejected and creates no membership', async () => {
      agentOwner = request.agent(agent.app);
      agentOutsider = request.agent(agent.app);

      // 1. Signup owner (auto-creates org), then an unrelated outsider
      try {
        const resOwner = await agentOwner
          .post('/api/auth/signup')
          .send({
            firstName: 'SelfJoinOwner',
            lastName: 'User',
            email: emailOwner,
            password,
            provider: 'local',
          })
          .expect(200);
        owner = resOwner.body.user;
        org = resOwner.body.organization;
        expect(org).toBeDefined();
        expect(org).not.toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const resOutsider = await agentOutsider
          .post('/api/auth/signup')
          .send({
            firstName: 'SelfJoinOutsider',
            lastName: 'User',
            email: emailOutsider,
            password,
            provider: 'local',
          })
          .expect(200);
        outsider = resOutsider.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 2. The outsider (NOT a member of org) tries to inject a membership for
      //    themselves. This must be forbidden (401/403) — the prior bug let it
      //    through via the unconditional create-Organization grant.
      try {
        const selfAddRes = await agentOutsider
          .post(`/api/organizations/${org._id}/members`)
          .send({ userId: outsider.id, role: 'member' });
        expect([401, 403]).toContain(selfAddRes.status);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 3. No membership row may have been created for the outsider in this org.
      try {
        const injected = await MembershipRepository.findOne({
          userId: outsider.id,
          organizationId: org._id,
        });
        expect(injected).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('the legitimate any-user JOIN-REQUEST flow (POST /:id/requests) still works for a non-member', async () => {
      // Precondition: the prior test must have seeded the outsider + org
      expect(org && outsider && agentOutsider).toBeTruthy();

      let requestId;
      try {
        const joinRes = await agentOutsider
          .post(`/api/organizations/${org._id}/requests`)
          .expect(200);
        expect(joinRes.body.message).toBe('membership request created');
        requestId = joinRes.body.data._id;
        expect(requestId).toBeDefined();
        expect(joinRes.body.data.status).toBe('pending');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // The owner approving it confirms the request is a real, owner-approvable
      // join_request (not an owner_add) — i.e. the carve-out preserved the flow.
      try {
        await agentOwner
          .put(`/api/organizations/${org._id}/requests/${requestId}/approve`)
          .expect(200);
        const active = await MembershipRepository.findOne({
          userId: outsider.id,
          organizationId: org._id,
          status: 'active',
        });
        expect(active).not.toBeNull();
        expect(active.role).toBe('member');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
