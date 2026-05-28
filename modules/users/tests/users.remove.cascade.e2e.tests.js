/**
 * E2E test: user deletion cascades org cleanup so co-members can still sign in.
 * Repro from issue #3709: User A (sole owner) deleted → Org X removed.
 * User B (active member of Org X, currentOrganization=X) must be able to sign in
 * without 500, with currentOrganization cleared to null.
 */
import request from 'supertest';
import path from 'path';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('users.service.remove cascade (#3709):', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

  const originalOrganizations = { ...config.organizations };

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

  afterAll(async () => {
    config.organizations = { ...originalOrganizations };
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('User B can sign in after User A (sole owner) is deleted', () => {
    let userA;
    let userB;
    let orgX;
    let agentA;
    let agentB;

    beforeAll(async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      agentA = request.agent(agent.app);
      agentB = request.agent(agent.app);
    });

    afterAll(async () => {
      // Best-effort cleanup
      try {
        if (userB) await UserService.remove(userB);
      } catch (_) { /* cleanup */ }
      try {
        if (orgX) {
          await MembershipRepository.deleteMany({ organizationId: orgX._id });
          await OrganizationsRepository.deleteMany({ _id: orgX._id });
        }
      } catch (_) { /* cleanup */ }
    });

    test('should not 500 on signin when currentOrganization points to a deleted org (issue #3709 repro)', async () => {
      // Step 1: User A signs up — auto-creates Org X
      try {
        const resA = await agentA
          .post('/api/auth/signup')
          .send({
            firstName: 'CascadeA',
            lastName: 'User',
            email: 'cascade-a-3709@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);
        userA = resA.body.user;
        orgX = resA.body.organization;
        expect(orgX).toBeDefined();
        expect(orgX).not.toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 2: User B signs up separately
      try {
        const resB = await agentB
          .post('/api/auth/signup')
          .send({
            firstName: 'CascadeB',
            lastName: 'User',
            email: 'cascade-b-3709@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);
        userB = resB.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 3: Directly create an ACTIVE membership for User B on Org X + set currentOrganization
      // (bypassing invite flow for test speed)
      try {
        const MembershipService = (await import(path.resolve('./modules/organizations/services/organizations.membership.service.js'))).default;
        await MembershipService.create({
          userId: userB._id || userB.id,
          organizationId: orgX._id,
          role: 'member',
          status: 'active',
        });
        // Set User B's currentOrganization to Org X directly
        await UserService.updateById(userB._id || userB.id, { currentOrganization: orgX._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 4: Delete User A (sole owner of Org X) — this should cascade-delete Org X + all memberships
      try {
        const brutUserA = await UserService.getBrut({ id: userA.id });
        await UserService.remove(brutUserA);
        userA = null; // Mark as cleaned
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 5: Verify Org X no longer exists
      try {
        const org = await OrganizationsRepository.get(orgX._id);
        expect(org).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 6: Verify User B's currentOrganization has been cleared (not left dangling)
      try {
        const brutUserB = await UserService.getBrut({ id: userB.id });
        // currentOrganization must be null or undefined — not the deleted org ID
        const currentOrgId = brutUserB.currentOrganization?._id || brutUserB.currentOrganization;
        expect(currentOrgId == null || String(currentOrgId) !== String(orgX._id)).toBe(true);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Step 7: User B signs in — must NOT 500 (was: "Cannot read properties of null (reading '_id')")
      try {
        const signinRes = await agentB
          .post('/api/auth/signin')
          .send({ email: 'cascade-b-3709@test.com', password: 'W@os.jsI$Aw3$0m3' })
          .expect(200); // Must be 200, not 500

        expect(signinRes.body.type).toBe('success');
        // currentOrganization must NOT be the deleted Org X (could be null or User B's own org)
        const signedInOrgId = signinRes.body.user.currentOrganization?._id || signinRes.body.user.currentOrganization;
        expect(signedInOrgId == null || String(signedInOrgId) !== String(orgX._id)).toBe(true);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });
});
