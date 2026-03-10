/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { jest, afterAll, beforeAll } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests
 */
describe('Organizations integration tests:', () => {
  let UserService;
  let OrganizationsService;
  let agent;
  let user;
  let _user;
  let organization1;

  // init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.service.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Logged', () => {
    beforeEach(async () => {
      _user = {
        firstName: 'Org',
        lastName: 'User',
        email: 'orgtest@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      };

      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // create an organization
      try {
        const result = await agent
          .post('/api/organizations')
          .send({ name: 'Test Org', slug: 'test-org' })
          .expect(200);
        organization1 = result.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to create an organization', async () => {
      try {
        const result = await agent
          .post('/api/organizations')
          .send({ name: 'Another Org', slug: 'another-org', plan: 'pro' })
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization created');
        expect(result.body.data.name).toBe('Another Org');
        expect(result.body.data.slug).toBe('another-org');
        expect(result.body.data.plan).toBe('pro');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to get an organization', async () => {
      try {
        const result = await agent.get(`/api/organizations/${organization1.id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization get');
        expect(result.body.data.id).toBe(organization1.id);
        expect(result.body.data.name).toBe('Test Org');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to get an organization with a bad id', async () => {
      try {
        const result = await agent.get('/api/organizations/invalidid').expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Organization with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to list user organizations', async () => {
      try {
        const result = await agent.get('/api/organizations').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization list');
        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data.length).toBeGreaterThanOrEqual(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to update an organization as owner', async () => {
      try {
        const result = await agent
          .put(`/api/organizations/${organization1.id}`)
          .send({ name: 'Updated Org', slug: 'test-org' })
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization updated');
        expect(result.body.data.name).toBe('Updated Org');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to delete an organization as owner', async () => {
      // Create a separate org to delete
      try {
        const createResult = await agent
          .post('/api/organizations')
          .send({ name: 'To Delete', slug: 'to-delete' })
          .expect(200);
        const orgToDelete = createResult.body.data;

        const result = await agent.delete(`/api/organizations/${orgToDelete.id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization deleted');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      // clean up organizations
      try {
        await OrganizationsService.remove(organization1);
      } catch (err) {
        // ignore cleanup errors
      }
      // delete user
      try {
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Logout', () => {
    test('should not be able to create an organization without auth', async () => {
      try {
        const result = await agent
          .post('/api/organizations')
          .send({ name: 'Unauth Org', slug: 'unauth-org' })
          .expect(401);
        expect(result.error.text).toBe('Unauthorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to list organizations without auth', async () => {
      try {
        const result = await agent.get('/api/organizations').expect(401);
        expect(result.error.text).toBe('Unauthorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  describe('Errors', () => {
    let errorUser;
    let errorOrganization;

    beforeAll(async () => {
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Error',
          lastName: 'Org',
          email: 'orgerror@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        errorUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      try {
        const orgResult = await agent
          .post('/api/organizations')
          .send({ name: 'Error Org', slug: 'error-org' })
          .expect(200);
        errorOrganization = orgResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 422 when create fails', async () => {
      jest.spyOn(OrganizationsService, 'create').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent
        .post('/api/organizations')
        .send({ name: 'Fail', slug: 'fail-org' })
        .expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when update fails', async () => {
      jest.spyOn(OrganizationsService, 'update').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent
        .put(`/api/organizations/${errorOrganization.id}`)
        .send({ name: 'Fail' })
        .expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when remove fails', async () => {
      jest.spyOn(OrganizationsService, 'remove').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.delete(`/api/organizations/${errorOrganization.id}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    afterAll(async () => {
      try {
        await OrganizationsService.remove(errorOrganization);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        await UserService.remove(errorUser);
      } catch (_) { /* cleanup – ignore errors */ }
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
