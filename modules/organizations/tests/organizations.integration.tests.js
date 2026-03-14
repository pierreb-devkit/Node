/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Integration tests for organization routes.
 * Verifies that authenticated users can access organization endpoints
 * without receiving 403 errors.
 */
describe('Organizations integration tests:', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

  // Store original config
  const originalOrganizations = { ...config.organizations };

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

  // init
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

  describe('GET /api/organizations', () => {
    let user;

    beforeAll(async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'OrgList',
            lastName: 'User',
            email: 'orglist@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 200 and an array for an authenticated user', async () => {
      try {
        const result = await agent.get('/api/organizations').expect(200);

        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization list');
        expect(result.body.data).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      await cleanupUser(user);
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    config.organizations = { ...originalOrganizations };
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
