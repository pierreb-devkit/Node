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

    test('second user signs up with same domain — pending join request, not auto-joined', async () => {
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

        // Verify the org is returned but join is pending (not active)
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization._id).toBe(org._id);
        expect(result.body.pendingJoin).toBe(true);
        expect(result.body.joined).toBeFalsy();

        // Verify NO active membership — only a pending request
        const activeMemberships = await MembershipRepository.list({
          userId: memberUser.id,
          organizationId: org._id,
          status: 'active',
        });
        expect(activeMemberships).toHaveLength(0);

        // Verify pending request exists
        const pendingMemberships = await MembershipRepository.list({
          userId: memberUser.id,
          organizationId: org._id,
          status: 'pending',
        });
        expect(pendingMemberships).toHaveLength(1);
        expect(pendingMemberships[0].role).toBe('member');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('owner can list pending requests and sees the new joiner — 200', async () => {
      try {
        const result = await agentOwner
          .get(`/api/organizations/${org._id}/requests`)
          .expect(200);

        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data.length).toBeGreaterThanOrEqual(1);
        // The pending request should be from the member user
        const pendingRequest = result.body.data.find(
          (r) => String(r.userId?._id || r.userId) === String(memberUser.id),
        );
        expect(pendingRequest).toBeDefined();
        expect(pendingRequest.status).toBe('pending');
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
