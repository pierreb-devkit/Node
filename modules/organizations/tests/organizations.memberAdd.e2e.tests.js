/**
 * @desc E2E tests for the owner-add membership lifecycle through real HTTP routes
 * (passport + CASL + param middleware): owner adds a member → pending row visible
 * in the members list → invited user accepts → owner promotes → member leaves.
 * Also covers the invited user's decline path and the duplicate-add guard (422).
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Organizations member-add E2E tests:', () => {
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

  describe('Full member-add lifecycle', () => {
    let userA;
    let userB;
    let orgA;
    let agentA;
    let agentB;

    // Finding #1: unique-per-run emails to avoid dirty-DB re-run flakiness
    const suffix = Date.now();
    const emailA = `member-add-a-${suffix}@test.com`;
    const emailB = `member-add-b-${suffix}@test.com`;

    // Finding #2: move config assignment into beforeAll so it is always set
    // before any test in this describe block runs
    beforeAll(() => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
    });

    afterAll(async () => {
      resetOrgConfig();
      // Clean up org A and its memberships, then B before A
      try {
        if (orgA) {
          await MembershipRepository.deleteMany({ organizationId: orgA._id });
          await OrganizationsRepository.deleteMany({ _id: orgA._id });
        }
      } catch (_) { /* cleanup */ }
      await cleanupUser(userB);
      await cleanupUser(userA);
    });

    test('full lifecycle: add → pending in list → accept → promote → leave', async () => {
      agentA = request.agent(agent.app);
      agentB = request.agent(agent.app);

      let membershipId;

      // 1. Signup user A (auto-creates org A), then user B
      try {
        const resultA = await agentA
          .post('/api/auth/signup')
          .send({
            firstName: 'MemberAddA',
            lastName: 'User',
            email: emailA,
            password,
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

      try {
        const resultB = await agentB
          .post('/api/auth/signup')
          .send({
            firstName: 'MemberAddB',
            lastName: 'User',
            email: emailB,
            password,
            provider: 'local',
          })
          .expect(200);
        userB = resultB.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 2. A looks up B by exact email. Asserts the /members/search route is
      // registered BEFORE /members/:memberId — if 'search' were captured as
      // :memberId, memberByID would 404 on the invalid ObjectId.
      try {
        const searchRes = await agentA
          .get(`/api/organizations/${orgA._id}/members/search`)
          .query({ email: emailB })
          .expect(200);
        expect(searchRes.body.message).toBe('user lookup');
        expect(searchRes.body.data).not.toBeNull();
        expect(searchRes.body.data.id).toBe(userB.id);
        expect(searchRes.body.data.email).toBe(emailB);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 3. A adds B → PENDING owner_add membership (consent not granted yet)
      try {
        const addRes = await agentA
          .post(`/api/organizations/${orgA._id}/members`)
          .send({ userId: userB.id, role: 'member' })
          .expect(200);
        expect(addRes.body.message).toBe('membership invitation created');
        membershipId = addRes.body.data._id;
        expect(membershipId).toBeDefined();
        expect(addRes.body.data.status).toBe('pending');
        expect(addRes.body.data.source).toBe('owner_add');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 4. The members list shows the pending owner_add row alongside the active
      // owner (pending owner_add rows are intentionally visible to the org).
      try {
        const listRes = await agentA.get(`/api/organizations/${orgA._id}/members`).expect(200);
        expect(listRes.body.message).toBe('membership list');
        const rowB = listRes.body.data.find((m) => m._id === membershipId);
        expect(rowB).toBeDefined();
        expect(rowB.status).toBe('pending');
        expect(rowB.source).toBe('owner_add');
        const rowA = listRes.body.data.find((m) => m.userId?.email === emailA);
        expect(rowA).toBeDefined();
        expect(rowA.status).toBe('active');
        expect(rowA.role).toBe('owner');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 5. B sees the invitation on the auth-only mine/pending surface
      try {
        const mineRes = await agentB.get('/api/membership-requests/mine/pending').expect(200);
        expect(mineRes.body.message).toBe('membership invitation list');
        const invite = mineRes.body.data.find((m) => m._id === membershipId);
        expect(invite).toBeDefined();
        expect(invite.status).toBe('pending');
        expect(invite.source).toBe('owner_add');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 6. B accepts (auth-only route, consent gate in the service) → ACTIVE
      try {
        const acceptRes = await agentB
          .put(`/api/membership-requests/${membershipId}/accept`)
          .expect(200);
        expect(acceptRes.body.message).toBe('membership invitation accepted');
        expect(acceptRes.body.data.status).toBe('active');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 7. A promotes B to admin through the :memberId param middleware
      try {
        const promoteRes = await agentA
          .put(`/api/organizations/${orgA._id}/members/${membershipId}`)
          .send({ role: 'admin' })
          .expect(200);
        expect(promoteRes.body.message).toBe('membership updated');
        expect(promoteRes.body.data.role).toBe('admin');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 8. B leaves → members list back to A only
      // Finding #4: assert identity (A's row) rather than a fragile bare count
      try {
        const leaveRes = await agentB.post(`/api/organizations/${orgA._id}/leave`).expect(200);
        expect(leaveRes.body.message).toBe('organization left');
        const finalList = await agentA.get(`/api/organizations/${orgA._id}/members`).expect(200);
        // precondition: B must not appear in the list after leaving
        expect(finalList.body.data.find((m) => m.userId?.email === emailB)).toBeUndefined();
        expect(finalList.body.data[0].userId?.email).toBe(emailA);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    // Jest runs test() blocks within a file in declaration order, so this runs after
    // the lifecycle test above (which leaves A owning org A and B with no membership);
    // the precondition assert below guards against that test having aborted.
    test('decline path: re-add → duplicate guard 422 → B declines → row gone everywhere', async () => {
      // Finding #2: guard against test-1 abort leaving shared state unpopulated
      // precondition: the lifecycle test must have populated shared state
      expect(orgA && userB && agentA && agentB).toBeTruthy();

      let declineId;

      // 1. A re-adds B → a fresh PENDING owner_add row
      try {
        const reAddRes = await agentA
          .post(`/api/organizations/${orgA._id}/members`)
          .send({ userId: userB.id, role: 'member' })
          .expect(200);
        declineId = reAddRes.body.data._id;
        expect(declineId).toBeDefined();
        expect(reAddRes.body.data.status).toBe('pending');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 2. Duplicate guard: adding B again while pending is rejected (422)
      // Finding #3: chain .expect(422) so a 500 is not swallowed
      try {
        const dupRes = await agentA
          .post(`/api/organizations/${orgA._id}/members`)
          .send({ userId: userB.id, role: 'member' })
          .expect(422);
        expect(dupRes.body.type).toBe('error');
        expect(dupRes.body.description).toBe('This user already has a pending membership for this organization.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 3. B sees the invitation, then DECLINES it (DELETE, auth-only)
      // Finding #5: assert the decline response body message
      try {
        const mineRes = await agentB.get('/api/membership-requests/mine/pending').expect(200);
        const invite = mineRes.body.data.find((m) => m._id === declineId);
        expect(invite).toBeDefined();

        const declineRes = await agentB.delete(`/api/membership-requests/${declineId}`).expect(200);
        expect(declineRes.body.message).toBe('membership invitation declined');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // 4. The row is gone everywhere — mine/pending, the members list, the DB
      // Finding #4: assert no B-row remains (identity) rather than a bare count
      try {
        const mineAfter = await agentB.get('/api/membership-requests/mine/pending').expect(200);
        expect(mineAfter.body.data.find((m) => m._id === declineId)).toBeUndefined();

        const listAfter = await agentA.get(`/api/organizations/${orgA._id}/members`).expect(200);
        expect(listAfter.body.data.find((m) => m._id === declineId)).toBeUndefined();
        // assert B is not in the list rather than relying on a hard count
        expect(listAfter.body.data.find((m) => m.userId?.email === emailB)).toBeUndefined();

        const row = await MembershipRepository.findOne({ _id: declineId });
        expect(row).toBeNull();
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
