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
 * Integration tests for organization-scoped task operations.
 * Verifies that tasks created within an organization context carry the
 * correct organizationId field, and that non-members cannot access
 * another organization's resources.
 */
describe('Tasks organization-scoped integration tests:', () => {
  let UserService;
  let OrganizationsService;
  let agent;
  let ownerUser;
  let nonMemberUser;
  let organization;

  // init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.crud.service.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Org-scoped task creation', () => {
    beforeAll(async () => {
      // Create owner user and sign in (signup auto-creates an org and sets currentOrganization)
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'OrgOwner',
          lastName: 'Tasks',
          email: 'orgtask-owner@orgtask1.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
        organization = result.body.organization;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should create a task with organizationId when user has currentOrganization', async () => {
      try {
        const result = await agent.post('/api/tasks').send({
          title: 'org-scoped task',
          description: 'belongs to org',
        }).expect(200);

        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task created');
        expect(result.body.data.organizationId).toBeDefined();
        expect(result.body.data.organizationId).toBe(organization.id || organization._id);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should always create tasks within the current organization context', async () => {
      try {
        const result = await agent.post('/api/tasks').send({
          title: 'second org task',
          description: 'also belongs to org',
        }).expect(200);

        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task created');
        expect(result.body.data.organizationId).toBe(organization.id || organization._id);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      // Cleanup: remove tasks, org, users
      try {
        const Task = mongoose.model('Task');
        await Task.deleteMany({ user: ownerUser.id });
      } catch (err) {
        console.log(err);
      }
      try {
        if (organization) await OrganizationsService.remove({ id: organization.id || organization._id, _id: organization._id || organization.id });
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(ownerUser);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Non-member org access', () => {
    let ownerOrg;

    beforeAll(async () => {
      // Create owner user and sign in (signup auto-creates an org)
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'OrgOwnerTwo',
          lastName: 'TasksTwo',
          email: 'orgtask-owner2@orgtask2.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
        ownerOrg = result.body.organization;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Sign out and create non-member user (uses a different domain to avoid domain-matching)
      try {
        await agent.get('/api/auth/signout');
      } catch (err) {
        console.log(err);
      }

      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'NonMember',
          lastName: 'User',
          email: 'orgtask-nonmember@other-domain.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        nonMemberUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Set currentOrganization on the non-member to the owner's org (they are NOT a member of)
      try {
        await agent.put('/api/users').send({ currentOrganization: ownerOrg.id || ownerOrg._id }).expect(200);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 403 when non-member tries to create a task in an org', async () => {
      try {
        const result = await agent.post('/api/tasks').send({
          title: 'unauthorized org task',
          description: 'should fail',
        }).expect(403);

        expect(result.body.type).toBe('error');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      try {
        if (ownerOrg) await OrganizationsService.remove({ id: ownerOrg.id || ownerOrg._id, _id: ownerOrg._id || ownerOrg.id });
      } catch (_) { /* cleanup */ }
      // Clean up non-member's auto-created org
      try {
        if (nonMemberUser) {
          const Membership = mongoose.model('Membership');
          const memberships = await Membership.find({ userId: nonMemberUser.id });
          for (const m of memberships) {
            try { await OrganizationsService.remove({ id: m.organizationId, _id: m.organizationId }); } catch (_) { /* cleanup */ }
          }
        }
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(ownerUser);
      } catch (_) { /* cleanup */ }
      try {
        await UserService.remove(nonMemberUser);
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
