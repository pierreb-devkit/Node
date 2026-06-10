/**
 * @desc E2E tests for the invitation lifecycle: admin issues an invite, a guest
 * signs up through the closed-signup gate with the invite token, and the invite is
 * single-use consumed. Exercises the real glob-wired module (routes, eligibility
 * hook, policy) end to end through the canonical /api/invitations mount.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Invitations E2E:', () => {
  let app;
  let UserService;

  const password = 'W@os.jsI$Aw3$0m3';
  const originalSign = {};

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    originalSign.up = config.sign.up;
    originalSign.cap = config.sign.cap;
  });

  afterEach(async () => {
    config.sign.up = originalSign.up;
    config.sign.cap = originalSign.cap;
    for (const email of ['e2e-inv-admin@test.com', 'e2e-invited-guest@test.com']) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    }
  });

  afterAll(async () => {
    config.sign.up = originalSign.up;
    config.sign.cap = originalSign.cap;
    try {
      await mongooseService.disconnect();
    } catch (_) { /* ignore */ }
  });

  /**
   * @description Create an admin and return a signed-in supertest agent.
   * @returns {Promise<import('supertest').SuperAgentTest>}
   */
  async function createAdminAndSignin() {
    const email = 'e2e-inv-admin@test.com';
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    config.sign.up = true;
    config.sign.cap = null;
    const adminAgent = request.agent(app);
    const signupRes = await adminAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Invite', lastName: 'Admin', email, password, provider: 'local' })
      .expect(200);
    const brut = await UserService.getBrut({ id: signupRes.body.user.id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');
    await adminAgent.post('/api/auth/signin').send({ email, password }).expect(200);
    return adminAgent;
  }

  test('full flow: admin invites → closed signup honored with token → invite consumed (single-use)', async () => {
    const adminAgent = await createAdminAndSignin();
    const guestEmail = 'e2e-invited-guest@test.com';

    // 1. Admin issues an invite (canonical mount)
    const created = await adminAgent.post('/api/invitations').send({ email: guestEmail }).expect(200);
    const { token } = created.body.data;
    expect(token).toBeDefined();

    // 2. Public verify reveals the prefilled email
    const verify = await request(app).get(`/api/invitations/verify/${token}`).expect(200);
    expect(verify.body.data).toEqual({ valid: true, email: guestEmail });

    // 3. Close public signup — only the invite token opens the gate now
    config.sign.up = false;
    config.sign.cap = null;

    // Without a token the guest is rejected
    const blocked = await request(app)
      .post('/api/auth/signup')
      .send({ email: guestEmail, password });
    expect(blocked.status).toBe(404);

    // With the token the guest gets in (eligibility hook resolves + returns the invite)
    const signup = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email: guestEmail, password })
      .expect(200);
    expect(signup.body.user.email).toBe(guestEmail);

    // 4. Single-use: the invite is now consumed, verify reports invalid
    const recheck = await request(app).get(`/api/invitations/verify/${token}`).expect(200);
    expect(recheck.body.data.valid).toBe(false);

    // 5. The same token cannot mint a second account
    const replay = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email: guestEmail, password });
    expect(replay.status).toBe(404);
  });
});
