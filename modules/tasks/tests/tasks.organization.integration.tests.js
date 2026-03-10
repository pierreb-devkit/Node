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
 * correct organizationId field, and that existing non-org flows continue
 * to work (backward compatibility).
 */
describe('Tasks organization-scoped integration tests:', () => {
  let UserService;
  let OrganizationsService;
  let MembershipService;
  let agent;
  let ownerUser;
  let nonMemberUser;
  let organization;
  let membership;

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

  describe('Org-scoped task creation', () => {
    beforeAll(async () => {
      // Create owner user and sign in
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'OrgOwner',
          lastName: 'Tasks',
          email: 'orgtask-owner@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create an organization
      try {
        const orgResult = await agent.post('/api/organizations').send({
          name: 'Task Test Org',
          slug: 'task-test-org',
        }).expect(200);
        organization = orgResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Set currentOrganization on the user
      try {
        await agent.put('/api/users/me').send({ currentOrganization: organization.id }).expect(200);
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
        expect(result.body.data.organizationId).toBe(organization.id);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should create a task without organizationId when user has no currentOrganization', async () => {
      // Clear currentOrganization
      try {
        await agent.put('/api/users/me').send({ currentOrganization: '' }).expect(200);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.post('/api/tasks').send({
          title: 'legacy task',
          description: 'no org context',
        }).expect(200);

        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task created');
        // organizationId should not be set
        expect(result.body.data.organizationId).toBeFalsy();
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
        await OrganizationsService.remove({ id: organization.id });
      } catch (err) {
        console.log(err);
      }
      try {
        await UserService.remove(ownerUser);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Non-member org access', () => {
    beforeAll(async () => {
      // Create owner user and sign in
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'OrgOwner2',
          lastName: 'Tasks2',
          email: 'orgtask-owner2@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        ownerUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Create an organization (this also creates a membership for the owner)
      try {
        const orgResult = await agent.post('/api/organizations').send({
          name: 'Access Test Org',
          slug: 'access-test-org',
        }).expect(200);
        organization = orgResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Sign out and create non-member user
      try {
        await agent.get('/api/auth/signout');
      } catch (err) {
        console.log(err);
      }

      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'NonMember',
          lastName: 'User',
          email: 'orgtask-nonmember@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        nonMemberUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Set currentOrganization on the non-member to the org they are NOT a member of
      try {
        await agent.put('/api/users/me').send({ currentOrganization: organization.id }).expect(200);
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
        expect(result.body.message).toBe('Forbidden');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      try {
        await OrganizationsService.remove({ id: organization.id });
      } catch (err) {
        console.log(err);
      }
      try {
        await UserService.remove(ownerUser);
      } catch (err) {
        console.log(err);
      }
      try {
        await UserService.remove(nonMemberUser);
      } catch (err) {
        console.log(err);
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
