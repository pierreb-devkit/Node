/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';

/**
 * Invitation integration tests
 */
describe('Signup invitations:', () => {
  let app;
  let UserService;

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
  });

  afterAll(async () => {
    // Clean up test users
    for (const email of [
      'inv-admin@test.com',
      'inv-user@test.com',
      'inv-admin2@test.com',
    ]) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    }
  });

  /**
   * Helper: create an admin user and return a bound supertest agent with the auth cookie.
   * Pattern mirrors auth.authorization.integration.tests.js:
   *   1. signup via /api/auth/signup
   *   2. promote to admin via UserService.update (roles stripped on signup)
   *   3. signin so the agent cookie jar holds the fresh JWT reflecting the new role
   */
  async function createAdminAndSignin() {
    const email = 'inv-admin@test.com';
    const password = 'W@os.jsI$Aw3$0m3';
    // Clean up stale user
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    const savedUp = config.sign.up;
    config.sign.up = true;
    const adminAgent = request.agent(app);
    const signupRes = await adminAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Inv', lastName: 'Admin', email, password, provider: 'local' })
      .expect(200);
    config.sign.up = savedUp;

    // Promote to admin
    const brut = await UserService.getBrut({ id: signupRes.body.user.id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');

    // Sign in so the agent cookie jar has a fresh token with admin role
    await adminAgent
      .post('/api/auth/signin')
      .send({ email, password })
      .expect(200);

    return adminAgent;
  }

  /**
   * Helper: create a regular user and return a bound supertest agent with the auth cookie.
   */
  async function createUserAndSignin() {
    const email = 'inv-user@test.com';
    const password = 'W@os.jsI$Aw3$0m3';
    // Clean up stale user
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    const savedUp = config.sign.up;
    config.sign.up = true;
    const userAgent = request.agent(app);
    await userAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Inv', lastName: 'User', email, password, provider: 'local' })
      .expect(200);
    config.sign.up = savedUp;

    await userAgent
      .post('/api/auth/signin')
      .send({ email, password })
      .expect(200);

    return userAgent;
  }

  describe('Signup invitations — admin CRUD', () => {
    test('admin can create, list, then revoke an invitation', async () => {
      const adminAgent = await createAdminAndSignin();

      const created = await adminAgent
        .post('/api/auth/invitations')
        .send({ email: 'Invitee@Example.com' });
      expect(created.status).toBe(200);
      expect(created.body.data.email).toBe('invitee@example.com');
      expect(created.body.data.token).toBeDefined();
      const id = created.body.data.id;

      const listed = await adminAgent.get('/api/auth/invitations');
      expect(listed.status).toBe(200);
      expect(listed.body.data.some((i) => i.id === id)).toBe(true);

      const removed = await adminAgent.delete(`/api/auth/invitations/${id}`);
      expect(removed.status).toBe(200);
    });

    test('non-admin is forbidden from creating invitations', async () => {
      const userAgent = await createUserAndSignin();
      const res = await userAgent.post('/api/auth/invitations').send({ email: 'x@y.co' });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Signup invitations — public verify', () => {
    test('verify returns { valid:true, email } for a fresh token and { valid:false } for garbage', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/auth/invitations').send({ email: 'verify@example.com' });
      const { token } = created.body.data;

      const ok = await request(app).get(`/api/auth/invitations/verify/${token}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ valid: true, email: 'verify@example.com' });

      const bad = await request(app).get('/api/auth/invitations/verify/deadbeef');
      expect(bad.status).toBe(200);
      expect(bad.body.data.valid).toBe(false);
    });
  });
});
