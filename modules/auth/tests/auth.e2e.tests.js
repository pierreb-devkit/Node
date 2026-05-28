/**
 * @desc E2E tests for auth signup flow with organizations.
 * Tests multi-step flows: signup → org auto-creation, domain matching, signin after signup.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Auth E2E tests:', () => {
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

  afterEach(() => {
    resetOrgConfig();
  });

  describe('Signup with auto org creation', () => {
    let user;

    afterEach(async () => {
      await cleanupUser(user);
      user = null;
    });

    test('should auto-create an organization on signup and assign owner role', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };

      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Autoorg',
            lastName: 'Testuser',
            email: 'e2e-auto-org@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // Verify org is auto-created
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization.name).toBe("Autoorg's organization");

        // Verify user has membership with role 'owner'
        const memberships = await MembershipRepository.list({
          userId: user.id,
          organizationId: result.body.organization._id,
          status: 'active',
        });
        expect(memberships).toHaveLength(1);
        expect(memberships[0].role).toBe('owner');

        // Verify user's currentOrganization is set
        expect(user.currentOrganization).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  describe('Signup with domain matching', () => {
    let firstUser;
    let secondUser;

    afterEach(async () => {
      await cleanupUser(secondUser);
      await cleanupUser(firstUser);
      firstUser = null;
      secondUser = null;
    });

    test('spec D5: second user with same domain gets own workspace + suggestedJoin (no pending join request)', async () => {
      // Spec D5 always-create: domain-match no longer creates a pending join request.
      // Both users get their own active workspace.
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true };

      try {
        // Step 1: signup first user to create org with domain 'e2etest.com'
        const result1 = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'DomainFirst',
            lastName: 'User',
            email: 'first@e2etest.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        firstUser = result1.body.user;
        const firstOrg = result1.body.organization;
        expect(firstOrg).toBeDefined();
        expect(firstOrg.domain).toBe('e2etest.com');

        // Step 2: signup second user with same domain — gets own workspace (spec D5)
        const result2 = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'DomainSecond',
            lastName: 'User',
            email: 'second@e2etest.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        secondUser = result2.body.user;

        // Second user gets their OWN active workspace (not a join on firstOrg)
        expect(result2.body.organization).toBeDefined();
        expect(result2.body.organization).not.toBeNull();
        expect(result2.body.organization._id).not.toBe(firstOrg._id);
        // pendingJoin is always false (spec D5)
        expect(result2.body.pendingJoin).toBeFalsy();

        // Second user has an ACTIVE membership on their new org (not pending on firstOrg)
        const activeMemberships = await MembershipRepository.list({
          userId: secondUser.id,
          organizationId: result2.body.organization._id,
          status: 'active',
        });
        expect(activeMemberships).toHaveLength(1);
        expect(activeMemberships[0].role).toBe('owner');

        // NO pending membership on firstOrg (spec D5: no join request created)
        const pendingOnFirst = await MembershipRepository.list({
          userId: secondUser.id,
          organizationId: firstOrg._id,
          status: 'pending',
        });
        expect(pendingOnFirst).toHaveLength(0);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  describe('Signin after signup', () => {
    let user;

    afterEach(async () => {
      await cleanupUser(user);
      user = null;
    });

    test('should signin successfully after signup and get valid JWT + abilities', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };

      try {
        // Step 1: signup
        const signupResult = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Signintest',
            lastName: 'User',
            email: 'e2e-signin@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = signupResult.body.user;

        // Step 2: signin with same credentials
        const signinResult = await agent
          .post('/api/auth/signin')
          .send({
            email: 'e2e-signin@test.com',
            password: 'W@os.jsI$Aw3$0m3',
          })
          .expect(200);

        // Verify JWT cookie is set
        const tokenCookie = signinResult.headers['set-cookie']?.find((c) => c.startsWith('TOKEN='));
        expect(tokenCookie).toBeDefined();

        // Verify response contains user and tokenExpiresIn
        expect(signinResult.body.user).toBeDefined();
        expect(signinResult.body.user.email).toBe('e2e-signin@test.com');
        expect(signinResult.body.tokenExpiresIn).toBeDefined();

        // Verify abilities are returned
        expect(signinResult.body.abilities).toBeDefined();
        expect(signinResult.body.abilities).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 200 on signin even when autoSetCurrentOrganization would encounter a data-integrity anomaly', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };

      // Signup user, then directly corrupt their currentOrganization to a non-existent ObjectId
      // to simulate a pre-existing dangling ref in prod
      try {
        const signupRes = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Danglingref',
            lastName: 'User',
            email: 'e2e-dangling-ref-3709@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = signupRes.body.user;
        // Directly write a bogus ObjectId as currentOrganization (simulates pre-existing corruption)
        const mongoose = (await import('mongoose')).default;
        const User = mongoose.model('User');
        await User.updateOne({ _id: user.id }, { currentOrganization: new mongoose.Types.ObjectId() });

        // Signin must NOT 500
        const signinRes = await agent
          .post('/api/auth/signin')
          .send({ email: 'e2e-dangling-ref-3709@test.com', password: 'W@os.jsI$Aw3$0m3' })
          .expect(200);

        expect(signinRes.body.type).toBe('success');
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
