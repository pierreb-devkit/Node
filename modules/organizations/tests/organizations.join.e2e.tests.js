/**
 * @desc E2E tests for the organization join request flow.
 * Tests: signup → request to join → reject → re-request → approve → verify membership.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations join request E2E tests:', () => {
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

  describe('Full join request flow', () => {
    let userA;
    let userB;
    let orgA;
    let agentA;
    let agentB;

    afterAll(async () => {
      // Clean up org A and its memberships
      try {
        if (orgA) {
          await MembershipRepository.deleteMany({ organizationId: orgA._id });
          await OrganizationsRepository.deleteMany({ _id: orgA._id });
        }
      } catch (_) { /* cleanup */ }
      await cleanupUser(userB);
      await cleanupUser(userA);
    });

    test('should complete the full join request flow: request → reject → re-request → approve', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      agentA = request.agent(agent.app);
      agentB = request.agent(agent.app);

      // Step 1: Signup user A, auto-creates org
      try {
        const resultA = await agentA
          .post('/api/auth/signup')
          .send({
            firstName: 'JoinA',
            lastName: 'User',
            email: 'join-a@test.com',
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

      // Step 2: Signup user B
      try {
        const resultB = await agentB
          .post('/api/auth/signup')
          .send({
            firstName: 'JoinB',
            lastName: 'User',
            email: 'join-b@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        userB = resultB.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 3: User B requests to join user A's org
      let requestId;
      try {
        const joinResult = await agentB
          .post(`/api/organizations/${orgA._id}/requests`)
          .expect(200);

        expect(joinResult.body.message).toBe('membership request created');
        requestId = joinResult.body.data._id;
        expect(requestId).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 4: User A sees pending request
      try {
        const pendingResult = await agentA
          .get(`/api/organizations/${orgA._id}/requests`)
          .expect(200);

        expect(pendingResult.body.data).toBeInstanceOf(Array);
        expect(pendingResult.body.data.length).toBeGreaterThanOrEqual(1);
        const pendingRequest = pendingResult.body.data.find((r) => r._id === requestId);
        expect(pendingRequest).toBeDefined();
        expect(pendingRequest.status).toBe('pending');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 5: User A rejects → verify membership is DELETED (not status=rejected)
      try {
        await agentA
          .put(`/api/organizations/${orgA._id}/requests/${requestId}/reject`)
          .expect(200);

        // Verify the membership record is deleted
        const deletedMembership = await MembershipRepository.findOne({
          userId: userB.id,
          organizationId: orgA._id,
          status: 'pending',
        });
        expect(deletedMembership).toBeNull();

        // Also verify no rejected status exists
        const rejectedMembership = await MembershipRepository.findOne({
          userId: userB.id,
          organizationId: orgA._id,
          status: 'rejected',
        });
        expect(rejectedMembership).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 6: User B re-requests to join (should work since record was deleted)
      let newRequestId;
      try {
        const reJoinResult = await agentB
          .post(`/api/organizations/${orgA._id}/requests`)
          .expect(200);

        expect(reJoinResult.body.message).toBe('membership request created');
        newRequestId = reJoinResult.body.data._id;
        expect(newRequestId).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 7: User A approves
      try {
        const approveResult = await agentA
          .put(`/api/organizations/${orgA._id}/requests/${newRequestId}/approve`)
          .expect(200);

        expect(approveResult.body.message).toBe('membership request approved');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 8: Verify user B is active member
      try {
        const membership = await MembershipRepository.findOne({
          userId: userB.id,
          organizationId: orgA._id,
          status: 'active',
        });
        expect(membership).toBeDefined();
        expect(membership).not.toBeNull();
        expect(membership.role).toBe('member');
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
