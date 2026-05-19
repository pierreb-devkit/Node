/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Integration tests for signup organization provisioning
 */
describe('Auth signup organization integration tests:', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

  // Store original config values
  const originalOrganizations = { ...config.organizations };

  /**
   * Helper to reset the organizations config to its original state.
   */
  const resetOrgConfig = () => {
    config.organizations = { ...originalOrganizations };
  };

  /**
   * Helper to clean up a user and their associated organizations/memberships.
   * @param {Object} user - The user object to clean up (must have id).
   * @returns {Promise<void>} Resolves when cleanup completes.
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

  /**
   * Remove a user by email if they exist (cleanup stale data from previous runs).
   * @param {string} email - email address of the user to purge
   * @returns {Promise<void>}
   */
  const purgeUser = async (email) => {
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await cleanupUser(existing);
    } catch (_) { /* cleanup – ignore errors */ }
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

  describe('Signup with organizations disabled', () => {
    test('should create a silent default organization for the user', async () => {
      config.organizations = { enabled: false, autoCreate: true, domainMatching: true };

      let user;
      // clean up stale users from previous runs on shared databases
      await purgeUser('silent-org@test.com');
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Silent',
            lastName: 'Org',
            email: 'silent-org@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // Organization should be created silently
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization.name).toBe("Silent's organization");
        expect(result.body.organizationSetupRequired).toBe(false);

        // Abilities should be present
        expect(result.body.abilities).toBeDefined();
        expect(result.body.abilities).toBeInstanceOf(Array);

        // User's currentOrganization should be set
        expect(result.body.user.currentOrganization).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(user);
      }
    });
  });

  describe('Signup with organizations enabled + autoCreate + domainMatching', () => {
    test('spec D5: second user with same domain gets own workspace + suggestedJoin hint (no pending request)', async () => {
      // Spec D5 always-create: domain-match no longer creates a pending join request.
      // Both users get their own active workspace; the second receives a suggestedJoin hint.
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true };

      let firstUser;
      let secondUser;
      await purgeUser('first@matchdomain.com');
      await purgeUser('second@matchdomain.com');
      try {
        // Sign up first user to create the org with domain
        const result1 = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'First',
            lastName: 'Employee',
            email: 'first@matchdomain.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        firstUser = result1.body.user;
        const firstOrg = result1.body.organization;
        expect(firstOrg).toBeDefined();
        expect(firstOrg.domain).toBe('matchdomain.com');

        // Sign up second user with same domain — spec D5: gets own workspace, not a join request
        const result2 = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Second',
            lastName: 'Employee',
            email: 'second@matchdomain.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        secondUser = result2.body.user;

        // Second user gets their OWN active workspace, not a reference to firstOrg
        expect(result2.body.organization).toBeDefined();
        expect(result2.body.organization).not.toBeNull();
        expect(result2.body.organization._id).not.toBe(firstOrg._id);
        expect(result2.body.pendingJoin).toBeFalsy();
        expect(result2.body.organizationSetupRequired).toBeFalsy();

        // Abilities should be present (with org context — user is owner of their own org)
        expect(result2.body.abilities).toBeDefined();
        expect(result2.body.abilities).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(secondUser);
        await cleanupUser(firstUser);
      }
    });

    test('should create a new organization when no domain match exists', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true };

      let user;
      // clean up stale users from previous runs on shared databases
      await purgeUser('solo@uniquedomain123.com');
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Solo',
            lastName: 'User',
            email: 'solo@uniquedomain123.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // A new organization should be created with the domain
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization.domain).toBe('uniquedomain123.com');
        expect(result.body.organization.name).toBe('Uniquedomain123');
        expect(result.body.organizationSetupRequired).toBe(false);

        // Abilities should be present
        expect(result.body.abilities).toBeDefined();
        expect(result.body.abilities).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(user);
      }
    });
  });

  describe('Signup with organizations enabled + autoCreate + no domainMatching', () => {
    test('should create a personal organization for the user (domainMatching off = personal name)', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };

      let user;
      await purgeUser('personal@somecompany.com');
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Personal',
            lastName: 'Org',
            email: 'personal@somecompany.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // domainMatching off → personal workspace name regardless of domain
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization.name).toBe("Personal's organization");
        expect(result.body.organization.domain).toBe('');
        expect(result.body.organizationSetupRequired).toBeFalsy();

        // Abilities should be present
        expect(result.body.abilities).toBeDefined();
        expect(result.body.abilities).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(user);
      }
    });
  });

  describe('Signup with organizations enabled + no autoCreate (spec D5: autoCreate is deprecated no-op)', () => {
    test('spec D5: autoCreate:false is a no-op — workspace always provisioned', async () => {
      // Spec D5: config.organizations.autoCreate is a deprecated no-op.
      // Signup ALWAYS provisions a workspace; organizationSetupRequired is never returned.
      config.organizations = { enabled: true, autoCreate: false, domainMatching: true };

      let user;
      await purgeUser('manual@setup.com');
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Manual',
            lastName: 'Setup',
            email: 'manual@setup.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // Workspace is always created now (spec D5)
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization).toBeDefined();
        // organizationSetupRequired defaults to false (auth controller || false)
        expect(result.body.organizationSetupRequired).toBeFalsy();

        // Abilities should be present (user is owner of their new workspace)
        expect(result.body.abilities).toBeDefined();
        expect(result.body.abilities).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(user);
      }
    });
  });

  describe('Signup response structure', () => {
    test('should include organization and abilities in signup response', async () => {
      config.organizations = { enabled: false, autoCreate: true, domainMatching: true };

      let user;
      // clean up stale users from previous runs on shared databases
      await purgeUser('response-check@test.com');
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'Response',
            lastName: 'Check',
            email: 'response-check@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);

        user = result.body.user;

        // Verify response structure includes the expected fields
        expect(result.body).toHaveProperty('user');
        expect(result.body).toHaveProperty('organization');
        expect(result.body).toHaveProperty('abilities');
        // organizationSetupRequired is always false (auth controller || false default)
        expect(result.body.organizationSetupRequired).toBeFalsy();
        expect(result.body).toHaveProperty('tokenExpiresIn');
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('Sign up');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        await cleanupUser(user);
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
