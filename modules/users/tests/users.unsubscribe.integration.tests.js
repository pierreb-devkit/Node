/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Public one-click unsubscribe route (#4162, RFC 8058):
 * POST /api/users/unsubscribe/:token — no auth, the token itself authorizes
 * the write. Covers the full round trip: a real `sendProductMail` call mints
 * the token, the route consumes it, and the persisted `emailPreferences`
 * reflects the change.
 */
describe('Unsubscribe integration tests:', () => {
  let UserService = null;
  let createUnsubscribeToken = null;
  let app;
  let agent;
  let user;

  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      ({ createUnsubscribeToken } = await import(path.resolve('./modules/users/utils/unsubscribeToken.js')));
      app = init.app;
      agent = request.agent(app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  beforeEach(async () => {
    try {
      const result = await agent.post('/api/auth/signup').send({
        firstName: 'First',
        lastName: 'Last',
        email: 'unsubscribe@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      }).expect(200);
      user = result.body.user;
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  afterEach(async () => {
    try {
      await UserService.remove(user);
    } catch (err) {
      console.log(err);
    }
  });

  test('a valid token turns the targeted kind off and leaves the other kind untouched', async () => {
    const token = createUnsubscribeToken(String(user.id), 'news');

    const result = await request(app).post(`/api/users/unsubscribe/${token}`).expect(200);
    expect(result.body.type).toBe('success');
    expect(result.body.data).toEqual({ kind: 'news' });

    const raw = await UserService.getBrut({ id: user.id });
    expect(raw.emailPreferences.news).toBe(false);
    expect(raw.emailPreferences.onboarding).toBe(true);
  });

  test('is idempotent — posting the same token twice is a no-op the second time, not an error', async () => {
    const token = createUnsubscribeToken(String(user.id), 'onboarding');
    await request(app).post(`/api/users/unsubscribe/${token}`).expect(200);
    await request(app).post(`/api/users/unsubscribe/${token}`).expect(200);

    const raw = await UserService.getBrut({ id: user.id });
    expect(raw.emailPreferences.onboarding).toBe(false);
  });

  test('rejects a tampered token (wrong kind swapped in) with 400, and does NOT write anything', async () => {
    const token = createUnsubscribeToken(String(user.id), 'news');
    const [userId, , sig] = token.split('.');
    const tampered = `${userId}.onboarding.${sig}`;

    const before = await UserService.getBrut({ id: user.id });

    const result = await request(app).post(`/api/users/unsubscribe/${tampered}`).expect(400);
    expect(result.body.type).toBe('error');

    const after = await UserService.getBrut({ id: user.id });
    // unchanged — a rejected token never reaches the write (both kinds still
    // at their signup-time default, whatever that was)
    expect(after.emailPreferences).toEqual(before.emailPreferences);
  });

  test('rejects a well-formed but unsigned token with 400', async () => {
    const result = await request(app).post(`/api/users/unsubscribe/${user.id}.news.${'0'.repeat(64)}`).expect(400);
    expect(result.body.type).toBe('error');
  });

  test('rejects a token for a user id that does not exist with 400', async () => {
    const token = createUnsubscribeToken('000000000000000000000000', 'news');
    const result = await request(app).post(`/api/users/unsubscribe/${token}`).expect(400);
    expect(result.body.type).toBe('error');
  });

  test('requires no authentication — works from an unauthenticated client', async () => {
    const token = createUnsubscribeToken(String(user.id), 'news');
    // a fresh, cookie-less client (not the signed-in `agent`)
    await request(app).post(`/api/users/unsubscribe/${token}`).expect(200);
  });

  test('a token with a valid signature but a kind outside the EmailKind enum hits the generic 422 path (defense in depth)', async () => {
    // The HMAC only binds (userId, kind) together — it has no opinion on which kind
    // strings are legal, so a token minted for a bogus kind still VERIFIES. The
    // rejection happens one layer up, in UserService.setEmailPreference's Zod parse,
    // which throws and is caught by the route's generic error handler (422), not the
    // route's own 400 "invalid token" branch.
    const token = createUnsubscribeToken(String(user.id), 'spam');
    const result = await request(app).post(`/api/users/unsubscribe/${token}`).expect(422);
    expect(result.body.type).toBe('error');
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
