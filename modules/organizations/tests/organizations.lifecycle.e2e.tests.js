/**
 * @desc E2E tests for the full organization lifecycle flow.
 * Tests: signup → invite → accept → promote → leave.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations lifecycle E2E tests:', () => {
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

  describe('Full invite lifecycle', () => {
    let userA;
    let userB;
    let orgA;
    let agentA;
    let agentB;

    afterAll(async () => {
      // Clean up remaining data
      try {
        if (orgA) {
          await MembershipRepository.deleteMany({ organizationId: orgA._id });
          await OrganizationsRepository.deleteMany({ _id: orgA._id });
        }
      } catch (_) { /* cleanup */ }
      // Clean up user B's auto-created org
      await cleanupUser(userB);
      await cleanupUser(userA);
    });

    test('should complete the full invite lifecycle: signup → invite → accept → promote → leave', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      agentA = request.agent(agent.app);
      agentB = request.agent(agent.app);

      // Step 1: Signup user A (creates org automatically)
      try {
        const resultA = await agentA
          .post('/api/auth/signup')
          .send({
            firstName: 'LifecycleA',
            lastName: 'User',
            email: 'lifecycle-a@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        userA = resultA.body.user;
        orgA = resultA.body.organization;
        expect(orgA).toBeDefined();
        expect(orgA).not.toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 2: User A invites user B by email
      let inviteToken;
      try {
        const inviteResult = await agentA
          .post(`/api/organizations/${orgA._id}/invites`)
          .send({ email: 'lifecycle-b@test.com' })
          .expect(200);

        expect(inviteResult.body.message).toBe('invitation sent');
        inviteToken = inviteResult.body.data.inviteToken;
        expect(inviteToken).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 3: Signup user B
      try {
        const resultB = await agentB
          .post('/api/auth/signup')
          .send({
            firstName: 'LifecycleB',
            lastName: 'User',
            email: 'lifecycle-b@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        userB = resultB.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 4: User B accepts the invite
      try {
        const acceptResult = await agentB
          .post(`/api/invites/${inviteToken}/accept`)
          .expect(200);

        expect(acceptResult.body.message).toBe('invitation accepted');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 5: Verify user B is now active member
      try {
        const membersResult = await agentA
          .get(`/api/organizations/${orgA._id}/members`)
          .expect(200);

        const memberB = membersResult.body.data.find(
          (m) => m.userId && m.userId.email === 'lifecycle-b@test.com',
        );
        expect(memberB).toBeDefined();
        expect(memberB.status).toBe('active');
        expect(memberB.role).toBe('member');

        // Step 6: User A promotes user B to owner
        const promoteResult = await agentA
          .put(`/api/organizations/${orgA._id}/members/${memberB._id}`)
          .send({ role: 'owner' })
          .expect(200);

        expect(promoteResult.body.data.role).toBe('owner');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 7: User A leaves the org
      try {
        const leaveResult = await agentA
          .post(`/api/organizations/${orgA._id}/leave`)
          .expect(200);

        expect(leaveResult.body.message).toBe('organization left');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 8: Verify user A membership is deleted
      try {
        const membershipA = await MembershipRepository.findOne({
          userId: userA.id,
          organizationId: orgA._id,
          status: 'active',
        });
        expect(membershipA).toBeNull();
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
