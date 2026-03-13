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

  describe('Signup with organizations disabled', () => {
    test('should create a silent default organization for the user', async () => {
      config.organizations = { enabled: false, autoCreate: true, domainMatching: true };

      let user;
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
    test('should create pending join request when domain matches existing org', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: true };

      // First, create an existing organization with a specific domain
      let firstUser;
      let secondUser;
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

        // Sign up second user with same domain — should get pending join request
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

        // Should reference the same org but with pending flag
        expect(result2.body.organization).toBeDefined();
        expect(result2.body.organization._id).toBe(firstOrg._id);
        expect(result2.body.pendingJoin).toBe(true);
        expect(result2.body.organizationSetupRequired).toBe(false);

        // Abilities should be present (without org context)
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
    test('should create a personal organization for the user', async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };

      let user;
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

        // A personal organization should be created (no domain matching)
        expect(result.body.organization).toBeDefined();
        expect(result.body.organization).not.toBeNull();
        expect(result.body.organization.name).toBe("Personal's organization");
        expect(result.body.organization.domain).toBe('');
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

  describe('Signup with organizations enabled + no autoCreate', () => {
    test('should not create an organization and flag setup as required', async () => {
      config.organizations = { enabled: true, autoCreate: false, domainMatching: true };

      let user;
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

        // No organization should be created
        expect(result.body.organization).toBeNull();
        expect(result.body.organizationSetupRequired).toBe(true);

        // Abilities should still be present (guest-level for org context)
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

        // Verify response structure includes the new fields
        expect(result.body).toHaveProperty('user');
        expect(result.body).toHaveProperty('organization');
        expect(result.body).toHaveProperty('abilities');
        expect(result.body).toHaveProperty('organizationSetupRequired');
        expect(result.body).toHaveProperty('tokenExpiresIn');
        expect(result.body.type).toBe('sucess');
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
