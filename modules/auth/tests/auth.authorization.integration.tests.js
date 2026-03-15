/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Authorization integration tests.
 *
 * These tests verify that every protected route enforces
 * the correct access-control rules:
 *   - guests cannot reach user-only endpoints
 *   - regular users cannot reach admin-only endpoints
 *   - non-owners cannot update/delete another user's resources
 */
describe('Authorization integration tests:', () => {
  let UserService;
  let agent; // authenticated agent (session-cookie persisted)
  let publicAgent; // unauthenticated agent
  let user;
  let adminUser;
  let adminAgent;
  let otherUser;
  let otherAgent;
  let task; // task owned by `user`
  const originalOrgEnabled = config.organizations.enabled;

  beforeAll(async () => {
    // Disable organizations so signup auto-creates a silent org with membership
    config.organizations.enabled = false;
    const init = await bootstrap();
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    agent = request.agent(init.app);
    publicAgent = request(init.app);
    adminAgent = request.agent(init.app);
    otherAgent = request.agent(init.app);

    // Create a normal user via agent
    const userRes = await agent
      .post('/api/auth/signup')
      .send({
        firstName: 'Auth',
        lastName: 'Tester',
        email: 'auth-test-user@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      })
      .expect(200);
    user = userRes.body.user;

    // Create a task owned by `user`
    const taskRes = await agent
      .post('/api/tasks')
      .send({ title: 'auth-test-task', description: 'owned by auth-test-user' })
      .expect(200);
    task = taskRes.body.data;

    // Upload an avatar for the user so we have an upload to test against
    await agent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);

    // Create an admin user via adminAgent (signup then promote via service — roles are stripped from signup)
    const adminRes = await adminAgent
      .post('/api/auth/signup')
      .send({
        firstName: 'Auth',
        lastName: 'Admin',
        email: 'auth-test-admin@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      })
      .expect(200);
    adminUser = adminRes.body.user;
    const adminBrut = await UserService.getBrut({ id: adminUser.id });
    await UserService.update(adminBrut, { roles: ['user', 'admin'] }, 'admin');

    // Create another normal user via otherAgent
    const otherRes = await otherAgent
      .post('/api/auth/signup')
      .send({
        firstName: 'Other',
        lastName: 'User',
        email: 'auth-test-other@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      })
      .expect(200);
    otherUser = otherRes.body.user;
  });

  // -------------------------------------------------------
  // GUEST cannot access user-only routes
  // -------------------------------------------------------
  describe('Guest cannot access user-only routes', () => {
    test('POST /api/tasks should return 401 for guests', async () => {
      await publicAgent.post('/api/tasks').send({ title: 'x', description: 'y' }).expect(401);
    });

    test('PUT /api/tasks/:taskId should return 401 for guests', async () => {
      await publicAgent.put(`/api/tasks/${task.id}`).send({ title: 'x', description: 'y' }).expect(401);
    });

    test('DELETE /api/tasks/:taskId should return 401 for guests', async () => {
      await publicAgent.delete(`/api/tasks/${task.id}`).expect(401);
    });

    test('GET /api/users/me should return 401 for guests', async () => {
      await publicAgent.get('/api/users/me').expect(401);
    });

    test('GET /api/users/terms should return 401 for guests', async () => {
      await publicAgent.get('/api/users/terms').expect(401);
    });

    test('PUT /api/users should return 401 for guests', async () => {
      await publicAgent.put('/api/users').send({ firstName: 'x' }).expect(401);
    });

    test('DELETE /api/users should return 401 for guests', async () => {
      await publicAgent.delete('/api/users').expect(401);
    });

    test('POST /api/users/password should return 401 for guests', async () => {
      await publicAgent.post('/api/users/password').send({}).expect(401);
    });

    test('POST /api/users/avatar should return 401 for guests', async () => {
      await publicAgent.post('/api/users/avatar').send({}).expect(401);
    });

    test('DELETE /api/users/avatar should return 401 for guests', async () => {
      await publicAgent.delete('/api/users/avatar').expect(401);
    });

    test('GET /api/users/data should return 401 for guests', async () => {
      await publicAgent.get('/api/users/data').expect(401);
    });

    test('DELETE /api/users/data should return 401 for guests', async () => {
      await publicAgent.delete('/api/users/data').expect(401);
    });

    test('GET /api/users/data/mail should return 401 for guests', async () => {
      await publicAgent.get('/api/users/data/mail').expect(401);
    });
  });

  // -------------------------------------------------------
  // GUEST can access public routes
  // -------------------------------------------------------
  describe('Guest can access public routes', () => {
    test('GET /api/tasks should return 401 for guests (auth required)', async () => {
      await publicAgent.get('/api/tasks').expect(401);
    });

    test('GET /api/tasks/stats should return 200 for guests', async () => {
      await publicAgent.get('/api/tasks/stats').expect(200);
    });

    test('GET /api/users/stats should return 200 for guests', async () => {
      await publicAgent.get('/api/users/stats').expect(200);
    });

    test('GET /api/home/releases should return 200 for guests', async () => {
      await publicAgent.get('/api/home/releases').expect(200);
    });

    test('GET /api/home/changelogs should return 200 for guests', async () => {
      await publicAgent.get('/api/home/changelogs').expect(200);
    });

    test('GET /api/home/team should return 200 for guests', async () => {
      await publicAgent.get('/api/home/team').expect(200);
    });
  });

  // -------------------------------------------------------
  // Regular USER cannot access admin routes
  // -------------------------------------------------------
  describe('Regular user cannot access admin routes', () => {
    test('GET /api/admin/users (admin list) should return 403 for regular user', async () => {
      const result = await agent.get('/api/admin/users').expect(403);
      expect(result.body.message).toBe('Unauthorized');
      expect(result.body.description).toBe('User is not authorized');
    });

    test('GET /api/admin/users/page/0 should return 403 for regular user', async () => {
      const result = await agent.get('/api/admin/users/page/0').expect(403);
      expect(result.body.message).toBe('Unauthorized');
    });

    test('GET /api/admin/users/:userId should return 403 for regular user', async () => {
      const result = await agent.get(`/api/admin/users/${adminUser._id}`).expect(403);
      expect(result.body.message).toBe('Unauthorized');
    });

    test('PUT /api/admin/users/:userId should return 403 for regular user', async () => {
      const result = await agent.put(`/api/admin/users/${adminUser._id}`).send({ firstName: 'x' }).expect(403);
      expect(result.body.message).toBe('Unauthorized');
    });

    test('DELETE /api/admin/users/:userId should return 403 for regular user', async () => {
      const result = await agent.delete(`/api/admin/users/${adminUser._id}`).expect(403);
      expect(result.body.message).toBe('Unauthorized');
    });
  });

  // -------------------------------------------------------
  // Non-owners cannot update/delete others' resources
  // -------------------------------------------------------
  describe('Non-owner cannot update/delete another user\'s task', () => {
    test('PUT /api/tasks/:taskId should return 403 for non-owner', async () => {
      const result = await otherAgent.put(`/api/tasks/${task.id}`).send({ title: 'hacked', description: 'nope' }).expect(403);
      expect(result.body.message).toBe('Unauthorized');
      expect(result.body.description).toBe('User is not authorized');
    });

    test('DELETE /api/tasks/:taskId should return 403 for non-owner', async () => {
      const result = await otherAgent.delete(`/api/tasks/${task.id}`).expect(403);
      expect(result.body.message).toBe('Unauthorized');
      expect(result.body.description).toBe('User is not authorized');
    });
  });

  // -------------------------------------------------------
  // Owner CAN update/delete own resources
  // -------------------------------------------------------
  describe('Owner can manage own resources', () => {
    test('GET /api/tasks/:taskId should return 200 for owner', async () => {
      await agent.get(`/api/tasks/${task.id}`).expect(200);
    });

    test('PUT /api/tasks/:taskId should return 200 for owner', async () => {
      const result = await agent.put(`/api/tasks/${task.id}`).send({ title: 'updated-title', description: 'updated-desc' }).expect(200);
      expect(result.body.data.title).toBe('updated-title');
    });
  });

  // -------------------------------------------------------
  // Admin CAN access admin routes
  // -------------------------------------------------------
  describe('Admin can access admin routes', () => {
    test('GET /api/admin/users (admin list) should return 200 for admin', async () => {
      await adminAgent.get('/api/admin/users').expect(200);
    });

    test('GET /api/admin/users/:userId should return 200 for admin', async () => {
      await adminAgent.get(`/api/admin/users/${user._id}`).expect(200);
    });
  });

  // -------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------
  afterAll(async () => {
    config.organizations.enabled = originalOrgEnabled;
    try { await agent.delete(`/api/tasks/${task.id}`); } catch (_) { /* ignore */ }
    try { await UserService.remove(user); } catch (_) { /* ignore */ }
    try { await UserService.remove(adminUser); } catch (_) { /* ignore */ }
    try { await UserService.remove(otherUser); } catch (_) { /* ignore */ }
    try { await mongooseService.disconnect(); } catch (_) { /* ignore */ }
  });
});
