/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import mongoose from 'mongoose';

import { afterAll, beforeAll } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for the organization switch endpoint.
 */
describe('Organizations switch integration tests:', () => {
  let UserService;
  let OrganizationsService;
  let agent;
  let ownerUser;
  let organization1;
  let organization2;

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

  describe('Switch organization', () => {
    beforeEach(async () => {
      // Create user
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Switch',
          lastName: 'User',
          email: 'switchuser@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create first organization
      try {
        const result = await agent
          .post('/api/organizations')
          .send({ name: 'Switch Org 1', slug: 'switch-org-1' })
          .expect(200);
        organization1 = result.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create second organization
      try {
        const result = await agent
          .post('/api/organizations')
          .send({ name: 'Switch Org 2', slug: 'switch-org-2' })
          .expect(200);
        organization2 = result.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should successfully switch organization and return new abilities', async () => {
      try {
        const result = await agent
          .post(`/api/organizations/${organization2.id}/switch`)
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization switched');
        expect(result.body.data.user).toBeDefined();
        expect(result.body.data.abilities).toBeDefined();
        expect(result.body.data.abilities).toBeInstanceOf(Array);
        expect(result.body.data.tokenExpiresIn).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should update user.currentOrganization in DB after switch', async () => {
      try {
        await agent
          .post(`/api/organizations/${organization2.id}/switch`)
          .expect(200);

        // Verify in database
        const User = mongoose.model('User');
        const dbUser = await User.findById(ownerUser.id).exec();
        expect(String(dbUser.currentOrganization)).toBe(String(organization2.id));
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 403 if user is not a member of target organization', async () => {
      try {
        // Create a second user who is not a member of organization1
        await agent.get('/api/auth/signout');
        const result2 = await agent.post('/api/auth/signup').send({
          firstName: 'NonMember',
          lastName: 'User',
          email: 'nonmember@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        const nonMemberUser = result2.body.user;

        const switchResult = await agent
          .post(`/api/organizations/${organization1.id}/switch`)
          .expect(403);
        expect(switchResult.body.type).toBe('error');
        expect(switchResult.body.message).toBe('Forbidden');

        // Clean up non-member user
        await UserService.remove(nonMemberUser);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 404 if organization does not exist', async () => {
      try {
        const fakeId = new mongoose.Types.ObjectId();
        const result = await agent
          .post(`/api/organizations/${fakeId}/switch`)
          .expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Organization with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      // Sign back in as owner to clean up
      await agent.get('/api/auth/signout');
      await agent.post('/api/auth/signin').send({
        email: 'switchuser@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      });

      try {
        await OrganizationsService.remove(organization1);
      } catch (_) { /* cleanup */ }
      try {
        await OrganizationsService.remove(organization2);
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(ownerUser);
      } catch (_) { /* cleanup */ }
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
