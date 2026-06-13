/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import { jest } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import mailer from '../../../lib/helpers/mailer/index.js';

/**
 * Email change must invalidate the verified state (#3825).
 *
 * Changing the account email through PUT /api/users (self) or
 * PUT /api/admin/users/:userId (admin) while keeping emailVerified:true lets
 * linkProviderByEmail ({ email, emailVerified: true }) attach an OAuth identity
 * to an address the account never proved it owns. On email change the service
 * must reset emailVerified, mint a new verification token, and send a
 * re-verification mail — but ONLY when the mailer is configured (mailer-less
 * deployments auto-verify at signup by design; resetting there would break
 * OAuth linking with no recovery path).
 *
 * The test-env mailer is unconfigured, so signup auto-verifies — the exact
 * starting state these tests need. Mailer-configured behavior is simulated
 * with jest.spyOn(mailer, 'isConfigured') applied AFTER signup, and
 * mailer.sendMail is stubbed so no template read / real send happens.
 */
describe('Email change re-verification integration tests:', () => {
  let UserService = null;
  let app;
  let agent;
  let credentials;
  let user;
  let _user;

  //  init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      app = init.app;
      agent = request.agent(app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Logged', () => {
    beforeEach(async () => {
      credentials = {
        email: 'email-change@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      };
      _user = {
        firstName: 'First',
        lastName: 'Last',
        email: credentials.email,
        password: credentials.password,
        provider: 'local',
      };

      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reset emailVerified and mint a new token on email change when mailer is configured', async () => {
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        // precondition — signup auto-verified (mailer was off at signup time)
        const before = await UserService.getBrut({ id: user.id });
        expect(before.emailVerified).toBe(true);

        await agent.put('/api/users').send({ email: 'email-change-new@test.com' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.email).toBe('email-change-new@test.com');
        expect(after.emailVerified).toBe(false);
        expect(after.emailVerificationToken).toMatch(/^[0-9a-f]{40}$/);
        expect(Number(after.emailVerificationExpires)).toBeGreaterThan(Date.now());

        // re-verification mail fired to the NEW address with the new token
        expect(sendMailSpy).toHaveBeenCalledTimes(1);
        const mail = sendMailSpy.mock.calls[0][0];
        expect(mail.template).toBe('verify-email');
        expect(mail.to).toBe('email-change-new@test.com');
        expect(mail.params.url).toContain(after.emailVerificationToken);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should NOT touch emailVerified on an update without email change', async () => {
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        await agent.put('/api/users').send({ firstName: 'StillVerified' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.firstName).toBe('StillVerified');
        expect(after.emailVerified).toBe(true);
        expect(after.emailVerificationToken == null).toBe(true);
        expect(sendMailSpy).not.toHaveBeenCalled();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should NOT reset when the new email is a case variant of the current one', async () => {
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        await agent.put('/api/users').send({ email: 'EMAIL-CHANGE@TEST.COM' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.email.toLowerCase()).toBe('email-change@test.com');
        expect(after.emailVerified).toBe(true);
        expect(after.emailVerificationToken == null).toBe(true);
        expect(sendMailSpy).not.toHaveBeenCalled();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should keep emailVerified true on email change when mailer is NOT configured', async () => {
      // No spies — the test-env mailer is genuinely unconfigured (trust-any-email mode).
      try {
        await agent.put('/api/users').send({ email: 'email-change-trusted@test.com' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.email).toBe('email-change-trusted@test.com');
        expect(after.emailVerified).toBe(true);
        expect(after.emailVerificationToken == null).toBe(true);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should stop linkProviderByEmail matching after an email change', async () => {
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        // positive control — the verified account on its current email links
        const linkedBefore = await UserService.linkProviderByEmail(_user.email, 'google', { id: 'g-before' });
        expect(linkedBefore).toBeTruthy();

        await agent.put('/api/users').send({ email: 'email-change-annex@test.com' }).expect(200);

        // the changed (now unverified) email must no longer link…
        const linkedAfter = await UserService.linkProviderByEmail('email-change-annex@test.com', 'google', { id: 'g-after' });
        expect(linkedAfter).toBeNull();
        // …and the old address no longer exists in db
        const linkedOld = await UserService.linkProviderByEmail(_user.email, 'google', { id: 'g-old' });
        expect(linkedOld).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should reset emailVerified on the admin update path too', async () => {
      // Promote the signed-in user to admin server-side (roles are stripped from
      // signup for security — same pattern as user.admin.integration.tests.js).
      try {
        const brut = await UserService.getBrut({ id: user.id });
        await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        await agent.put(`/api/admin/users/${user.id}`).send({ email: 'email-change-admin@test.com' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.email).toBe('email-change-admin@test.com');
        expect(after.emailVerified).toBe(false);
        expect(after.emailVerificationToken).toMatch(/^[0-9a-f]{40}$/);
        expect(sendMailSpy).toHaveBeenCalledTimes(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should re-verify end-to-end with the new token', async () => {
      let token;
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        await agent.put('/api/users').send({ email: 'email-change-everify@test.com' }).expect(200);

        const brut = await UserService.getBrut({ id: user.id });
        expect(brut.emailVerified).toBe(false);
        token = brut.emailVerificationToken;
        expect(token).toMatch(/^[0-9a-f]{40}$/);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }

      try {
        const result = await agent.post(`/api/auth/verify-email/${token}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.data.emailVerified).toBe(true);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.emailVerified).toBe(true);
        expect(after.emailVerificationToken).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not fail the update when the verification mail send rejects', async () => {
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockRejectedValue(new Error('SMTP down'));
      try {
        await agent.put('/api/users').send({ email: 'email-change-smtp@test.com' }).expect(200);

        const after = await UserService.getBrut({ id: user.id });
        expect(after.emailVerified).toBe(false);
        expect(sendMailSpy).toHaveBeenCalledTimes(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    test('should NOT reset emailVerified or send mail on the recover update path', async () => {
      // 'recover' is the internal verification writer (verifyEmail / password reset) — it
      // SETS verification state, so the email-change guard is exempt for it (option !== 'recover').
      // Even an email in the recover body must not trigger a reset or a re-verification mail,
      // else verifyEmail would clobber the very emailVerified:true it just wrote.
      const isConfiguredSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      const sendMailSpy = jest.spyOn(mailer, 'sendMail').mockResolvedValue(null);
      try {
        const brut = await UserService.getBrut({ id: user.id });
        await UserService.update(brut, { email: 'recover-change@test.com', emailVerified: true }, 'recover');

        const after = await UserService.getBrut({ id: user.id });
        expect(after.emailVerified).toBe(true);
        expect(sendMailSpy).not.toHaveBeenCalled();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        isConfiguredSpy.mockRestore();
        sendMailSpy.mockRestore();
      }
    });

    afterEach(async () => {
      // del user (removal is by id, so it works whatever email the test left behind)
      try {
        await UserService.remove(user);
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
