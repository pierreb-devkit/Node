/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { afterAll, beforeAll } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests
 */
describe('Organizations membership integration tests:', () => {
  let UserService;
  let OrganizationsService;
  let MembershipService;
  let agent;
  let ownerUser;
  let memberUser;
  let organization;

  // init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.service.js'))).default;
      MembershipService = (await import(path.resolve('./modules/organizations/services/organizations.membership.service.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Membership management', () => {
    beforeEach(async () => {
      // Create owner user
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Owner',
          lastName: 'User',
          email: 'membershipowner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create organization as owner
      try {
        const orgResult = await agent
          .post('/api/organizations')
          .send({ name: 'Membership Org', slug: 'membership-org' })
          .expect(200);
        organization = orgResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to list members of an organization', async () => {
      try {
        const result = await agent
          .get(`/api/organizations/${organization.id}/members`)
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('membership list');
        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data).toHaveLength(1);
        expect(result.body.data[0].role).toBe('owner');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to invite a member by email', async () => {
      try {
        const result = await agent
          .post(`/api/organizations/${organization.id}/members/invite`)
          .send({ email: 'invite@test.com', role: 'member' })
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('invitation created');
        expect(result.body.data.email).toBe('invite@test.com');
        expect(result.body.data.role).toBe('member');
        expect(result.body.data.token).toBeDefined();
        expect(result.body.data.expiresAt).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to change a member role', async () => {
      // First add a member directly
      try {
        // Create a second user
        await agent.get('/api/auth/signout');
        const result2 = await agent.post('/api/auth/signup').send({
          firstName: 'Member',
          lastName: 'User',
          email: 'memberrole@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        memberUser = result2.body.user;

        // Log back in as owner
        await agent.get('/api/auth/signout');
        await agent.post('/api/auth/signin').send({
          email: 'membershipowner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        }).expect(200);

        // Create membership directly
        const membership = await MembershipService.create({
          userId: memberUser.id,
          organizationId: organization.id,
          role: 'member',
        });

        const updateResult = await agent
          .put(`/api/organizations/${organization.id}/members/${membership.id}`)
          .send({ role: 'admin' })
          .expect(200);
        expect(updateResult.body.type).toBe('success');
        expect(updateResult.body.message).toBe('membership updated');
        expect(updateResult.body.data.role).toBe('admin');

        // Clean up member user
        await UserService.remove(memberUser);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to remove a member from an organization', async () => {
      try {
        // Create a second user
        await agent.get('/api/auth/signout');
        const result2 = await agent.post('/api/auth/signup').send({
          firstName: 'Remove',
          lastName: 'User',
          email: 'memberremove@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        memberUser = result2.body.user;

        // Log back in as owner
        await agent.get('/api/auth/signout');
        await agent.post('/api/auth/signin').send({
          email: 'membershipowner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        }).expect(200);

        // Create membership directly
        const membership = await MembershipService.create({
          userId: memberUser.id,
          organizationId: organization.id,
          role: 'member',
        });

        const deleteResult = await agent
          .delete(`/api/organizations/${organization.id}/members/${membership.id}`)
          .expect(200);
        expect(deleteResult.body.type).toBe('success');
        expect(deleteResult.body.message).toBe('membership deleted');

        // Clean up member user
        await UserService.remove(memberUser);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      try {
        await OrganizationsService.remove(organization);
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(ownerUser);
      } catch (_) { /* cleanup */ }
    });
  });

  describe('Permission checks', () => {
    let memberUserPerm;

    beforeAll(async () => {
      // Create owner
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'PermOwner',
          lastName: 'User',
          email: 'permowner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create organization
      try {
        const orgResult = await agent
          .post('/api/organizations')
          .send({ name: 'Perm Org', slug: 'perm-org' })
          .expect(200);
        organization = orgResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Sign out, create member user
      await agent.get('/api/auth/signout');
      try {
        const result2 = await agent.post('/api/auth/signup').send({
          firstName: 'PermMember',
          lastName: 'User',
          email: 'permmember@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        memberUserPerm = result2.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Add member user to organization
      try {
        await MembershipService.create({
          userId: memberUserPerm.id,
          organizationId: organization.id,
          role: 'member',
        });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('member should not be able to update an organization', async () => {
      // Already signed in as member from beforeAll
      try {
        const result = await agent
          .put(`/api/organizations/${organization.id}`)
          .send({ name: 'Hacked' })
          .expect(403);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Unauthorized');
        expect(result.body.description).toBe('User is not authorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('member should not be able to delete an organization', async () => {
      try {
        const result = await agent
          .delete(`/api/organizations/${organization.id}`)
          .expect(403);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Unauthorized');
        expect(result.body.description).toBe('User is not authorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('member should be able to read an organization', async () => {
      try {
        const result = await agent
          .get(`/api/organizations/${organization.id}`)
          .expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization get');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      // Sign back in as owner to clean up
      await agent.get('/api/auth/signout');
      await agent.post('/api/auth/signin').send({
        email: 'permowner@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      });

      try {
        await OrganizationsService.remove(organization);
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(ownerUser);
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(memberUserPerm);
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
