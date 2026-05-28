/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
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

  describe('Local signup gate (cap + invite)', () => {
    let originalUp; let originalCap;
    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(() => { config.sign.up = originalUp; config.sign.cap = originalCap; });

    test('signup disabled + no invite → 404', async () => {
      config.sign.up = false; config.sign.cap = null;
      const res = await request(app).post('/api/auth/signup').send({ email: 'nope@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
    });

    test('signup disabled + valid invite token → account created and invite consumed', async () => {
      // Create admin while signup is still open (beforeEach saves/restores; we set false after admin creation)
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/auth/invitations').send({ email: 'guest@example.com' });
      const { token } = created.body.data;

      // Now close public signup — the invite path must still work
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'guest@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      const recheck = await request(app).get(`/api/auth/invitations/verify/${token}`);
      expect(recheck.body.data.valid).toBe(false);
    });

    test('signup disabled + invite token but email mismatch → 404', async () => {
      // Create admin and invitation while signup is open
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/auth/invitations').send({ email: 'pinned@example.com' });
      const { token } = created.body.data;

      // Now close public signup
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'someoneelse@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
    });

    test('cap reached → 404 even with a valid invite (invites count in the cap)', async () => {
      config.sign.up = true;
      const total = await UserService.count();
      config.sign.cap = total; // total >= cap → blocked
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/auth/invitations').send({ email: 'capped@example.com' });
      const { token } = created.body.data;
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'capped@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
    });

    test('under cap + signup open → normal signup works', async () => {
      config.sign.up = true; config.sign.cap = null;
      const res = await request(app).post('/api/auth/signup').send({ email: 'open@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);
    });
  });

  describe('OAuth signup gate (cap + email-matched invite)', () => {
    let AuthController;
    let originalUp; let originalCap;

    beforeAll(async () => {
      AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
    });

    beforeEach(() => {
      originalUp = config.sign.up;
      originalCap = config.sign.cap;
    });

    afterEach(async () => {
      config.sign.up = originalUp;
      config.sign.cap = originalCap;
      // Clean up any OAuth gate test users
      for (const email of ['oauth-gate-blocked@test.com', 'oauth-gate-invited@test.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup */ }
      }
    });

    test('signup disabled + no invite for provider email → OAuth signup rejected (VALIDATION_ERROR)', async () => {
      config.sign.up = false;
      config.sign.cap = null;

      const profil = {
        firstName: 'Blocked',
        lastName: 'OAuth',
        email: 'oauth-gate-blocked@test.com',
        avatar: '',
        providerData: { sub: 'google-gate-blocked-sub' },
        emailVerifiedByProvider: true,
      };

      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { message: 'Registration is currently deactivated' },
      });

      // Ensure no user was persisted
      const users = await UserService.search({ email: 'oauth-gate-blocked@test.com' });
      expect(users.length).toBe(0);
    });

    test('signup disabled + valid invite for provider email → OAuth signup succeeds and invite consumed', async () => {
      // Create admin and invitation while signup is still open
      const adminAgent = await createAdminAndSignin();
      const invEmail = 'oauth-gate-invited@test.com';
      const created = await adminAgent.post('/api/auth/invitations').send({ email: invEmail });
      expect(created.status).toBe(200);
      const { token } = created.body.data;

      // Now close public signup — the email-matched invite path must still allow creation
      config.sign.up = false;
      config.sign.cap = null;

      const profil = {
        firstName: 'Invited',
        lastName: 'OAuth',
        email: invEmail,
        avatar: '',
        providerData: { sub: 'google-gate-invited-sub' },
        emailVerifiedByProvider: true,
      };

      const createdUser = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
      expect(createdUser).toBeDefined();
      expect(createdUser.email).toBe(invEmail);

      // Invite must be consumed — verify token is no longer valid
      const recheck = await request(app).get(`/api/auth/invitations/verify/${token}`);
      expect(recheck.body.data.valid).toBe(false);
    });
  });
});
