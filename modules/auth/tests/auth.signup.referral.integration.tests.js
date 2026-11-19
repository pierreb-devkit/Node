/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import { jest, afterEach } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';
import { encodeReferralCode } from '../../users/lib/users.referralCode.js';

/**
 * Integration tests — shareable referral link (#4212), through the real Express
 * app + Mongo: the referrer reads their code on `GET /api/users/me`, a signup
 * carrying it is credited (`referredBy`), a bad code never fails the signup, and
 * a link referral triggers NO billing grant (credit only).
 */
describe('Auth signup referral link integration tests:', () => {
  let UserService;
  let BillingReferralService;
  let app;
  let referrerAgent;
  let referrerId;
  let previousReferral;

  const password = 'W@os.jsI$Aw3$0m3';
  const emails = {
    referrer: 'ref-link-referrer@test.com',
    referee: 'ref-link-referee@test.com',
    bad: 'ref-link-bad@test.com',
    off: 'ref-link-off@test.com',
  };

  /**
   * @desc Remove leftover test users from a previous run.
   * @returns {Promise<void>}
   */
  const cleanupUsers = async () => {
    for (const email of Object.values(emails)) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
    }
  };

  const signup = (email, extra = {}) => request(app).post('/api/auth/signup').send({
    firstName: 'Ref', lastName: 'Link', email, password, provider: 'local', ...extra,
  });

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    BillingReferralService = (await import(path.resolve('./modules/billing/services/billing.referral.service.js'))).default;
    previousReferral = config.billing.referral;
    config.billing.referral = { ...previousReferral, enabled: true };
    await cleanupUsers();
    referrerAgent = request.agent(app);
    await signup(emails.referrer).expect(200);
    const signedIn = await referrerAgent.post('/api/auth/signin').send({ email: emails.referrer, password });
    expect(signedIn.status).toBe(200);
    referrerId = String((await UserService.getBrut({ email: emails.referrer })).id);
  });

  // A test that flips the flag and then fails mid-way must not leak `enabled:false`
  // into the next test.
  afterEach(() => {
    config.billing.referral = { ...previousReferral, enabled: true };
  });

  afterAll(async () => {
    config.billing.referral = previousReferral;
    await cleanupUsers();
  });

  test('the authenticated user reads their personal code on /api/users/me, only when referral is enabled', async () => {
    const res = await referrerAgent.get('/api/users/me').expect(200);
    expect(res.body.data.referralCode).toBe(encodeReferralCode(referrerId));

    config.billing.referral = { ...previousReferral, enabled: false };
    const off = await referrerAgent.get('/api/users/me').expect(200);
    config.billing.referral = { ...previousReferral, enabled: true };
    expect(off.body.data).not.toHaveProperty('referralCode');
  });

  test('a signup with a valid ref credits the referrer, persists no ref field, and triggers no billing grant', async () => {
    const grantSpy = jest.spyOn(BillingReferralService, 'grantForInvitation');
    await signup(emails.referee, { ref: encodeReferralCode(referrerId) }).expect(200);
    await new Promise((resolve) => setImmediate(resolve));
    const brut = await UserService.getBrut({ email: emails.referee });
    expect(String(brut.referredBy)).toBe(referrerId);
    expect(brut.toObject()).not.toHaveProperty('ref');
    expect(grantSpy).not.toHaveBeenCalled();
    grantSpy.mockRestore();
  });

  test('an unknown or undecodable ref never fails the signup and attributes nothing', async () => {
    await signup(emails.bad, { ref: 'zzzzzzzzzzzzzzzz' }).expect(200);
    const brut = await UserService.getBrut({ email: emails.bad });
    expect(brut.referredBy).toBeFalsy();
  });

  test('with referral disabled the ref is ignored', async () => {
    config.billing.referral = { ...previousReferral, enabled: false };
    await signup(emails.off, { ref: encodeReferralCode(referrerId) }).expect(200);
    config.billing.referral = { ...previousReferral, enabled: true };
    const brut = await UserService.getBrut({ email: emails.off });
    expect(brut.referredBy).toBeFalsy();
  });
});
