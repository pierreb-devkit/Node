/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Abilities integration tests.
 *
 * These tests verify that signin and token refresh responses
 * include a serialized `abilities` array compatible with
 * CASL's createMongoAbility() on the client side.
 */
describe('Auth abilities integration tests:', () => {
  let UserService;
  let agent;
  let adminAgent;
  let user;
  let adminUser;

  const userCredentials = {
    email: 'abilities-user@test.com',
    password: 'W@os.jsI$Aw3$0m3',
  };

  const adminCredentials = {
    email: 'abilities-admin@test.com',
    password: 'W@os.jsI$Aw3$0m3',
  };

  beforeAll(async () => {
    const init = await bootstrap();
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    agent = request.agent(init.app);
    adminAgent = request.agent(init.app);

    // Create a regular user
    const userRes = await agent
      .post('/api/auth/signup')
      .send({
        firstName: 'Abilities',
        lastName: 'User',
        email: userCredentials.email,
        password: userCredentials.password,
        provider: 'local',
      })
      .expect(200);
    user = userRes.body.user;

    // Create an admin user
    const adminRes = await adminAgent
      .post('/api/auth/signup')
      .send({
        firstName: 'Abilities',
        lastName: 'Admin',
        email: adminCredentials.email,
        password: adminCredentials.password,
        provider: 'local',
        roles: ['user', 'admin'],
      })
      .expect(200);
    adminUser = adminRes.body.user;
  });

  // -------------------------------------------------------
  // Signin response includes abilities
  // -------------------------------------------------------
  describe('Signin response', () => {
    test('should include abilities array for a regular user', async () => {
      const result = await agent.post('/api/auth/signin').send(userCredentials).expect(200);
      expect(result.body.abilities).toBeDefined();
      expect(Array.isArray(result.body.abilities)).toBe(true);
      expect(result.body.abilities.length).toBeGreaterThan(0);
    });

    test('should include abilities array for an admin user', async () => {
      const result = await adminAgent.post('/api/auth/signin').send(adminCredentials).expect(200);
      expect(result.body.abilities).toBeDefined();
      expect(Array.isArray(result.body.abilities)).toBe(true);
      expect(result.body.abilities.length).toBeGreaterThan(0);
    });

    test('abilities format should have action and subject fields', async () => {
      const result = await agent.post('/api/auth/signin').send(userCredentials).expect(200);
      for (const rule of result.body.abilities) {
        expect(rule).toHaveProperty('action');
        expect(rule).toHaveProperty('subject');
        expect(typeof rule.action).toBe('string');
        expect(typeof rule.subject).toBe('string');
      }
    });

    test('regular user abilities should contain task rules with conditions', async () => {
      const result = await agent.post('/api/auth/signin').send(userCredentials).expect(200);
      const taskUpdateRule = result.body.abilities.find(
        (r) => r.action === 'update' && r.subject === 'Task',
      );
      expect(taskUpdateRule).toBeDefined();
      expect(taskUpdateRule.conditions).toBeDefined();
      expect(taskUpdateRule.conditions.user).toBe(String(user._id));
    });

    test('admin abilities should contain manage/all rule', async () => {
      const result = await adminAgent.post('/api/auth/signin').send(adminCredentials).expect(200);
      const manageAll = result.body.abilities.find(
        (r) => r.action === 'manage' && r.subject === 'all',
      );
      expect(manageAll).toBeDefined();
    });
  });

  // -------------------------------------------------------
  // Token refresh response includes abilities
  // -------------------------------------------------------
  describe('Token refresh response', () => {
    test('should include abilities array for a regular user', async () => {
      // Ensure session is active
      await agent.post('/api/auth/signin').send(userCredentials).expect(200);
      const result = await agent.get('/api/auth/token').expect(200);
      expect(result.body.abilities).toBeDefined();
      expect(Array.isArray(result.body.abilities)).toBe(true);
      expect(result.body.abilities.length).toBeGreaterThan(0);
    });

    test('should include abilities array for an admin user', async () => {
      await adminAgent.post('/api/auth/signin').send(adminCredentials).expect(200);
      const result = await adminAgent.get('/api/auth/token').expect(200);
      expect(result.body.abilities).toBeDefined();
      expect(Array.isArray(result.body.abilities)).toBe(true);
    });

    test('abilities format should have action and subject fields', async () => {
      await agent.post('/api/auth/signin').send(userCredentials).expect(200);
      const result = await agent.get('/api/auth/token').expect(200);
      for (const rule of result.body.abilities) {
        expect(rule).toHaveProperty('action');
        expect(rule).toHaveProperty('subject');
        expect(typeof rule.action).toBe('string');
        expect(typeof rule.subject).toBe('string');
      }
    });

    test('admin token refresh should contain manage/all rule', async () => {
      await adminAgent.post('/api/auth/signin').send(adminCredentials).expect(200);
      const result = await adminAgent.get('/api/auth/token').expect(200);
      const manageAll = result.body.abilities.find(
        (r) => r.action === 'manage' && r.subject === 'all',
      );
      expect(manageAll).toBeDefined();
    });
  });

  // -------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------
  afterAll(async () => {
    try { await UserService.remove(user); } catch (_) { /* cleanup */ }
    try { await UserService.remove(adminUser); } catch (_) { /* cleanup */ }
    try { await mongooseService.disconnect(); } catch (_) { /* cleanup */ }
  });
});
