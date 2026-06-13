/**
 * @desc E2E tests for the owner_add decline flow (#3831).
 * Tests: signup owner → signup invitee → owner adds invitee (pending owner_add,
 * visible in the members list) → the owner CANNOT decline on the invitee's
 * behalf (404, consent) → the invitee declines (row deleted) → the invitee can
 * then request to join — proving the createJoinRequest copy
 * 'Please accept or decline it' is honest.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations owner_add decline E2E tests:', () => {
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

  describe('Full decline flow', () => {
    let owner;
    let invitee;
    let org;
    let agentOwner;
    let agentInvitee;

    afterAll(async () => {
      try {
        if (org) {
          await MembershipRepository.deleteMany({ organizationId: org._id });
          await OrganizationsRepository.deleteMany({ _id: org._id });
        }
      } catch (_) { /* cleanup */ }
      await cleanupUser(invitee);
      await cleanupUser(owner);
    });

    test('owner adds → invite visible → owner cannot decline → invitee declines → invitee can request to join', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      agentOwner = request.agent(agent.app);
      agentInvitee = request.agent(agent.app);

      // Step 1: signup the owner, auto-creates the org
      const resultOwner = await agentOwner
        .post('/api/auth/signup')
        .send({
          firstName: 'DeclineOwner',
          lastName: 'User',
          email: 'decline-owner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        })
        .expect(200);
      owner = resultOwner.body.user;
      org = resultOwner.body.organization;
      expect(org).toBeDefined();
      expect(org).not.toBeNull();

      // Step 2: signup the invitee
      const resultInvitee = await agentInvitee
        .post('/api/auth/signup')
        .send({
          firstName: 'DeclineInvitee',
          lastName: 'User',
          email: 'decline-invitee@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        })
        .expect(200);
      invitee = resultInvitee.body.user;

      // Step 3: owner adds the invitee → PENDING owner_add membership
      const addResult = await agentOwner
        .post(`/api/organizations/${org._id}/members`)
        .send({ userId: invitee.id })
        .expect(200);
      expect(addResult.body.message).toBe('membership invitation created');
      const invitationId = addResult.body.data._id;
      expect(invitationId).toBeDefined();

      // Step 4: the pending invite is now VISIBLE in the owner's members list,
      // with status + source so the UI can render the pending state.
      const membersResult = await agentOwner
        .get(`/api/organizations/${org._id}/members`)
        .expect(200);
      const pendingRow = membersResult.body.data.find((m) => m._id === invitationId);
      expect(pendingRow).toBeDefined();
      expect(pendingRow.status).toBe('pending');
      expect(pendingRow.source).toBe('owner_add');

      // Step 5: the OWNER cannot decline on the invitee's behalf → 404 (consent
      // gate, same opaque copy as accept) and the row survives.
      await agentOwner
        .delete(`/api/membership-requests/${invitationId}`)
        .expect(404);
      const stillThere = await MembershipRepository.findOne({
        userId: invitee.id,
        organizationId: org._id,
        status: 'pending',
      });
      expect(stillThere).not.toBeNull();

      // Step 6: the INVITEE declines → 200, row DELETED (not flagged)
      const declineResult = await agentInvitee
        .delete(`/api/membership-requests/${invitationId}`)
        .expect(200);
      expect(declineResult.body.message).toBe('membership invitation declined');
      const deleted = await MembershipRepository.findOne({
        userId: invitee.id,
        organizationId: org._id,
      });
      expect(deleted).toBeNull();

      // Step 7: the 'Please accept or decline it' copy is honest — having
      // declined, the invitee can now request to join (no pending row blocks it).
      const joinResult = await agentInvitee
        .post(`/api/organizations/${org._id}/requests`)
        .expect(200);
      expect(joinResult.body.message).toBe('membership request created');
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
