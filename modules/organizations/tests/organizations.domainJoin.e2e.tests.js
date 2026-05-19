/**
 * @desc E2E tests for the domain auto-join flow and membership request endpoint security.
 * Tests: domain signup → owner creation → member join → request endpoint authorization.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations domain join E2E tests:', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

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

  describe('Domain auto-join and request endpoint security', () => {
    let ownerUser;
    let memberUser;
    let org;
    let agentOwner;
    let agentMember;

    afterAll(async () => {
      try {
        if (org) {
          await MembershipRepository.deleteMany({ organizationId: org._id });
          await OrganizationsRepository.deleteMany({ _id: org._id });
        }
      } catch (_) { /* cleanup */ }
      await cleanupUser(memberUser);
      await cleanupUser(ownerUser);
    });

    test('first user signs up with domain email — creates org, is owner', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true, publicDomains: ['gmail.com'] };
      agentOwner = request.agent(agent.app);

      try {
        const result = await agentOwner
          .post('/api/auth/signup')
          .send({
            firstName: 'DomainOwner',
            lastName: 'User',
            email: 'owner@testdomain.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        ownerUser = result.body.user;
        org = result.body.organization;

        // Verify org is created with domain name
        expect(org).toBeDefined();
        expect(org).not.toBeNull();
        expect(org.domain).toBe('testdomain.com');
        expect(result.body.organizationSetupRequired).toBe(false);

        // Verify membership role is owner
        const memberships = await MembershipRepository.list({
          userId: ownerUser.id,
          organizationId: org._id,
          status: 'active',
        });
        expect(memberships).toHaveLength(1);
        expect(memberships[0].role).toBe('owner');

        // Verify no joined flag (first user creates, does not join)
        expect(result.body.joined).toBeFalsy();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('second user signs up with same domain — always gets own workspace + suggestedJoin hint (spec D5)', async () => {
      // Spec D5: signup always provisions a workspace. Domain-match no longer creates a pending
      // join request — instead, a suggestedJoin hint is returned alongside the user's new org.
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true, publicDomains: ['gmail.com'] };
      agentMember = request.agent(agent.app);

      try {
        const result = await agentMember
          .post('/api/auth/signup')
          .send({
            firstName: 'DomainMember',
            lastName: 'User',
            email: 'member@testdomain.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        memberUser = result.body.user;

        // Spec D5: always-create — member gets their OWN active workspace
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        // pendingJoin is gone — service never returns it (controller defaults to false)
        expect(result.body.pendingJoin).toBeFalsy();
        expect(result.body.joined).toBeFalsy();

        // Member has their own active membership (not a pending request on owner's org)
        const activeMemberships = await MembershipRepository.list({
          userId: memberUser.id,
          organizationId: result.body.organization._id,
          status: 'active',
        });
        expect(activeMemberships).toHaveLength(1);
        expect(activeMemberships[0].role).toBe('owner');

        // suggestedJoin hint returned (name-only) pointing to owner's org
        // controller still emits suggestedOrganization (always null post-footgun-removal);
        // suggestedJoin is wired to the response in a follow-up (A2b).
        expect(result.body.suggestedOrganization).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('owner pending requests list — no pending requests from member (member has own org)', async () => {
      // After spec D5: domain-match no longer creates join requests.
      // Member got their own org instead of a pending request on owner's org.
      try {
        const result = await agentOwner
          .get(`/api/organizations/${org._id}/requests`)
          .expect(200);

        expect(result.body.data).toBeInstanceOf(Array);
        // No pending requests — member did not create a join request (spec D5)
        const pendingFromMember = result.body.data.filter(
          (r) => String(r.userId?._id || r.userId) === String(memberUser?.id),
        );
        expect(pendingFromMember).toHaveLength(0);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('member cannot list pending requests on owner org — returns empty array — 200', async () => {
      try {
        const result = await agentMember
          .get(`/api/organizations/${org._id}/requests`)
          .expect(200);

        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data).toHaveLength(0);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    resetOrgConfig();
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
