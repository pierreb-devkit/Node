/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import _ from 'lodash';
import { jest } from '@jest/globals';
import passport from 'passport';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

/**
 * Unit tests
 */
describe('Auth integration tests:', () => {
  let UserService = null;
  let AuthService = null;
  let agent;
  let credentials;
  let user;
  let userEdited;
  let _user;
  let _userEdited;

  //  init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      AuthService = (await import(path.resolve('./modules/auth/services/auth.service.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  /**
   * User routes tests
   */
  describe('Registration', () => {
    beforeEach(async () => {
      // users credentials
      credentials = [
        {
          email: 'auth@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        },
        {
          email: 'auth2@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        },
      ];

      // users
      _user = {
        firstName: 'First',
        lastName: 'Last',
        email: credentials[0].email,
        password: credentials[0].password,
        provider: 'local',
      };
      _userEdited = _.clone(_user);
      _userEdited.email = credentials[1].email;
      _userEdited.password = credentials[1].password;

      // clean up stale users from previous runs on shared databases
      for (const email of [credentials[0].email, credentials[1].email, 'register_new_user_@test.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup – ignore errors */ }
      }

      // add user
      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reject signup when signup configuration is disabled', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';
      config.sign.up = false;
      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Signup error');
        expect(result.body.description).toBe('Registration is currently deactivated');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      config.sign.up = true;
    });

    test('should reject registration when password is weak', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';
      _userEdited.password = 'azerty';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(422);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Schema validation error');
        expect(result.body.description).toEqual('Password must have a strength of at least 3. Password length must be at least 8 characters long. ');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not expose sensitive data when registration fails', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';
      _userEdited.password = 'azerty';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(422);

        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Schema validation error');
        expect(result.body.description).toEqual('Password must have a strength of at least 3. Password length must be at least 8 characters long. ');
        expect(JSON.parse(result.body.error)._original.password).toBeUndefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should register a new user when firstName is omitted (digit-only email local-part)', async () => {
      const digitOnlyPayload = {
        email: '123@test.com',
        password: credentials[1].password,
        provider: 'local',
      };
      try {
        const existing = await UserService.getBrut({ email: digitOnlyPayload.email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }

      let created;
      try {
        const result = await agent.post('/api/auth/signup').send(digitOnlyPayload).expect(200);
        created = result.body.user;
        expect(result.body.user.email).toBe(digitOnlyPayload.email);
        expect(result.body.user.firstName).toBe('');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        try { if (created) await UserService.remove(created); } catch (_) { /* cleanup */ }
      }
    });

    test('should register a new user successfully', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(200);
        userEdited = result.body.user;

        expect(result.body.user._id).toBe(result.body.user.id);
        expect(result.body.user.email).toBe(_userEdited.email);
        expect(result.body.user.provider).toBe('local');
        expect(result.body.user.roles).toBeInstanceOf(Array);
        expect(result.body.user.roles).toHaveLength(1);
        expect(result.body.user.roles).toEqual(expect.arrayContaining(['user']));
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove(userEdited);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reject registration when email is already in use', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(200);
        userEdited = result.body.user;
        expect(result.body.user.email).toBe(_userEdited.email);
        expect(result.body.user.roles).toBeInstanceOf(Array);
        expect(result.body.user.roles).toHaveLength(1);
        expect(result.body.user.roles).toEqual(expect.arrayContaining(['user']));
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(422);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toEqual('Unprocessable Entity');
        expect(result.body.description).toBe('Email already exists.');
      } catch (err) {
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove(userEdited);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reject login when login configuration is disabled', async () => {
      // Init user edited
      _userEdited.email = 'register_new_user_@test.com';
      config.sign.in = false;
      try {
        const result = await agent.post('/api/auth/signin').send(credentials[0]).expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Signin error');
        expect(result.body.description).toBe('Login is currently deactivated');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      config.sign.in = true;
    });

    test('should reject login when email is incorrect', async () => {
      try {
        const result = await agent
          .post('/api/auth/signin')
          .send({
            email: 'test51@test.com',
            password: 'W@os.jsI$Aw3$0m3',
          })
          .expect(401);
        expect(result.body.message).toBe('Unauthorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should login successfully with correct email', async () => {
      try {
        await agent.post('/api/auth/signin').send(credentials[0]).expect(200);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should refresh token successfully', async () => {
      try {
        const signinResult = await agent.post('/api/auth/signin').send(credentials[0]).expect(200);
        const oldExpiration = signinResult.body.tokenExpiresIn;
        const refreshResult = await agent.get('/api/auth/token').expect(200);
        const newExpiration = refreshResult.body.tokenExpiresIn;
        expect(oldExpiration).not.toBe(newExpiration);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reject login with correct email but wrong password', async () => {
      try {
        const result = await agent
          .post('/api/auth/signin')
          .send({
            email: credentials[0].email,
            password: 'WrongPassword!123',
          })
          .expect(401);
        expect(result.body.message).toBe('Unauthorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('forgot password request for non-existent email should return 400', async () => {
      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: 'falseemail@gmail.com',
          })
          .expect(400);

        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('No account with that email has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('forgot password request with empty email should return 422', async () => {
      _userEdited.provider = 'facebook';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(200);
        userEdited = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: '',
          })
          .expect(422);
        expect(result.body.message).toEqual('Unprocessable Entity');
        expect(result.body.description).toBe('Mail field must not be blank');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove(userEdited);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('forgot password request for non-local provider should return 400', async () => {
      _userEdited.provider = 'facebook';

      try {
        const result = await agent.post('/api/auth/signup').send(_userEdited).expect(200);
        userEdited = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: userEdited.email,
          })
          .expect(400);
        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe(`It seems like you signed up using your ${userEdited.provider} account`);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove(userEdited);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should initiate password reset process for valid email', async () => {
      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: user.email,
          })
          .expect(400);
        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Failure sending email');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await UserService.getBrut({
          email: user.email,
        });
        expect(typeof result).toBe('object');
        expect(result.resetPasswordToken).toBeDefined();
        expect(result.resetPasswordExpires).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should allow password reset with valid reset token', async () => {
      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: user.email,
          })
          .expect(400);

        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Failure sending email');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await UserService.getBrut({
          email: user.email,
        });
        expect(typeof result).toBe('object');
        expect(result.resetPasswordToken).toBeDefined();
        expect(result.resetPasswordExpires).toBeDefined();

        try {
          const result2 = await agent.get(`/api/auth/reset/${result.resetPasswordToken}`).expect(302);
          expect(result2.headers.location).toBe(`/api/password/reset/${result.resetPasswordToken}`);
        } catch (err) {
          console.log(err);
          expect(err).toBeFalsy();
        }
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should reject password reset with invalid reset token', async () => {
      try {
        const result = await agent
          .post('/api/auth/forgot')
          .send({
            email: user.email,
          })
          .expect(400);

        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Failure sending email');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await UserService.getBrut({
          email: user.email,
        });
        expect(typeof result).toBe('object');
        expect(result.resetPasswordToken).toBeDefined();
        expect(result.resetPasswordExpires).toBeDefined();

        try {
          const invalidToken = 'someTOKEN1234567890';
          const result2 = await agent.get(`/api/auth/reset/${invalidToken}`).expect(302);
          expect(result2.headers.location).toBe('/api/password/reset/invalid');
        } catch (err) {
          console.log(err);
          expect(err).toBeFalsy();
        }
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      // del user
      try {
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('OAuth profile and service branches', () => {
    let AuthController;
    const oauthUsers = [];

    beforeAll(async () => {
      AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
      // clean up any leftover users from a previously failed run
      for (const email of ['noprovider@auth-test.com', 'oauthprofile@test.com', 'oauthfind@test.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup – ignore errors */ }
      }
    });

    test('should create user with default provider when none is specified', async () => {
      const result = await UserService.create({
        firstName: 'No',
        lastName: 'Provider',
        email: 'noprovider@auth-test.com',
        password: 'P@ss!W0rd123',
        roles: ['user'],
        // provider intentionally omitted to trigger the default branch
      });
      expect(result.provider).toBe('local');
      oauthUsers.push(result);
    });

    test('should create an OAuth user without password via checkOAuthUserProfile', async () => {
      const profil = {
        firstName: 'OAuth',
        lastName: 'Test',
        email: 'oauthprofile@test.com',
        avatar: '',
        providerData: { id: 'google-fake-id-999' },
      };
      const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.email).toBe(profil.email);
      oauthUsers.push(result);
    });

    test('should throw validation AppError when checkOAuthUserProfile receives an invalid profile', async () => {
      const invalidProfil = {
        firstName: 'Invalid1', // invalid — digits fail the names refinement
        lastName: 'Test',
        email: 'invalid-oauth@test.com',
        avatar: '',
        providerData: { id: 'google-invalid-999' },
      };
      await expect(
        AuthController.checkOAuthUserProfile(invalidProfil, 'id', 'google'),
      ).rejects.toMatchObject({
        message: 'Schema validation error',
        code: 'VALIDATION_ERROR',
        details: {
          message: expect.any(String),
        },
      });
    });

    test('should throw AppError when create fails inside checkOAuthUserProfile', async () => {
      const profil = {
        firstName: 'OAuth',
        lastName: 'Err',
        email: 'oautherr@test.com',
        avatar: '',
        providerData: { id: 'google-err-000' },
      };
      const createSpy = jest.spyOn(UserService, 'create').mockRejectedValueOnce(new Error('DB error'));
      await expect(
        AuthController.checkOAuthUserProfile(profil, 'id', 'google'),
      ).rejects.toThrow('oAuth');
      createSpy.mockRestore();
    });

    test('should authenticate via client-side OAuth and set tokenCookieOptions on response', async () => {
      const oauthEmail = 'oauthcb-appauth@test.com';
      try {
        const result = await agent
          .post('/api/auth/google/callback')
          .send({ strategy: false, key: 'id', value: 'cb-app-auth-id-999', firstName: 'OAuth', lastName: 'Callback', email: oauthEmail })
          .expect(200);
        const tokenCookie = result.headers['set-cookie']?.find((c) => c.startsWith('TOKEN='));
        expect(tokenCookie).toBeDefined();
        expect(tokenCookie).toMatch(/HttpOnly/i);
        expect(tokenCookie).toMatch(/SameSite=Strict/i);
        expect(result.body.message).toBe('oAuth Ok');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      } finally {
        try {
          const u = await UserService.getBrut({ email: oauthEmail });
          if (u) await UserService.remove(u);
        } catch (_) { /* cleanup */ }
      }
    });

    test('should return 422 when client-side OAuth callback receives an invalid profile', async () => {
      const result = await agent
        .post('/api/auth/google/callback')
        .send({
          strategy: false,
          key: 'id',
          value: 'cb-app-auth-id-invalid-999',
          firstName: 'Invalid1',
          lastName: 'Callback',
          email: 'oauthcb-invalid@test.com',
        })
        .expect(422);

      expect(result.body.type).toBe('error');
      expect(result.body.message).toMatch(/^Schema validation error/);
      expect(result.body.description).toEqual(expect.any(String));
    });

    test('should set tokenCookieOptions and redirect on classic web oAuth success', async () => {
      const mockUserId = 'mock-oauth-user-id-123';
      const authenticateSpy = jest.spyOn(passport, 'authenticate').mockImplementationOnce(
        (strategy, callback) => () => callback(null, { id: mockUserId }),
      );
      const cookies = {};
      const redirectCalls = [];
      const mockReq = { params: { strategy: 'google' }, body: {} };
      const mockRes = {
        cookie(name, val, opts) { cookies[name] = { val, opts }; return this; },
        redirect(code, url) { redirectCalls.push({ code, url }); },
      };

      await AuthController.oauthCallback(mockReq, mockRes, () => {});

      expect(cookies.TOKEN).toBeDefined();
      expect(cookies.TOKEN.opts.httpOnly).toBe(true);
      expect(cookies.TOKEN.opts.sameSite).toBe(config.cookie.sameSite);
      expect(redirectCalls[0]).toMatchObject({ code: 302 });
      expect(redirectCalls[0].url).toMatch(/\/token$/);
      authenticateSpy.mockRestore();
    });

    test('should handle GET callback when req.body is undefined (Express 5)', async () => {
      const authenticateSpy = jest.spyOn(passport, 'authenticate').mockImplementationOnce(
        (strategy, callback) => () => callback(null, { id: 'mock-get-cb-user' }),
      );
      const cookies = {};
      const redirectCalls = [];
      const mockReq = { params: { strategy: 'google' } };
      const mockRes = {
        cookie(name, val, opts) { cookies[name] = { val, opts }; return this; },
        redirect(code, url) { redirectCalls.push({ code, url }); },
      };

      await AuthController.oauthCallback(mockReq, mockRes, () => {});

      expect(cookies.TOKEN).toBeDefined();
      expect(redirectCalls[0]).toMatchObject({ code: 302 });
      authenticateSpy.mockRestore();
    });

    test('should log and redirect with message when classic web oAuth errors out', async () => {
      const oauthErr = new Error('token exchange failed');
      oauthErr.code = 'OAUTH_TOKEN_EXCHANGE';
      const authenticateSpy = jest.spyOn(passport, 'authenticate').mockImplementationOnce(
        (strategy, callback) => () => callback(oauthErr, null),
      );
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const redirectCalls = [];
      const mockReq = { params: { strategy: 'google' }, body: {} };
      const mockRes = {
        cookie() { return this; },
        redirect(code, url) { redirectCalls.push({ code, url }); },
      };

      await AuthController.oauthCallback(mockReq, mockRes, () => {});

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            message: 'token exchange failed',
            code: 'OAUTH_TOKEN_EXCHANGE',
            stack: expect.any(String),
          }),
          strategy: 'google',
        }),
        'OAuth callback failed',
      );
      expect(redirectCalls[0].code).toBe(302);
      // Redirect must carry the actual error message, not an empty object
      expect(redirectCalls[0].url).toContain('error=');
      expect(redirectCalls[0].url).not.toContain('error={}');
      expect(redirectCalls[0].url).toContain(encodeURIComponent('token exchange failed'));

      loggerSpy.mockRestore();
      authenticateSpy.mockRestore();
    });

    test('should log and redirect with sensible message when no user is returned by passport', async () => {
      const authenticateSpy = jest.spyOn(passport, 'authenticate').mockImplementationOnce(
        (strategy, callback) => () => callback(null, null),
      );
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const redirectCalls = [];
      const mockReq = { params: { strategy: 'google' }, body: {} };
      const mockRes = {
        cookie() { return this; },
        redirect(code, url) { redirectCalls.push({ code, url }); },
      };

      await AuthController.oauthCallback(mockReq, mockRes, () => {});

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            message: undefined,
            code: undefined,
            stack: undefined,
          }),
          strategy: 'google',
        }),
        'OAuth callback failed',
      );
      expect(redirectCalls[0].code).toBe(302);
      expect(redirectCalls[0].url).toContain('error=');
      expect(redirectCalls[0].url).not.toContain('error={}');
      expect(redirectCalls[0].url).toContain('oauth_no_user');
      expect(redirectCalls[0].url).toContain('Could%20not%20define%20user%20in%20oAuth');

      loggerSpy.mockRestore();
      authenticateSpy.mockRestore();
    });

    test('should find an existing OAuth user via checkOAuthUserProfile', async () => {
      // Create an OAuth user directly first
      const createdUser = await UserService.create({
        firstName: 'OAuth',
        lastName: 'Find',
        email: 'oauthfind@test.com',
        provider: 'google',
        providerData: { id: 'google-find-id-777' },
        roles: ['user'],
      });

      const profil = {
        firstName: 'OAuth',
        lastName: 'Find',
        email: 'oauthfind@test.com',
        avatar: '',
        providerData: { id: 'google-find-id-777' },
      };
      // Second call — should find the existing user (search.length === 1 branch)
      const found = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');
      expect(found).toBeDefined();

      // cleanup
      try {
        await UserService.remove(createdUser);
      } catch (_) { /* cleanup – ignore errors */ }
    });

    test('should link OAuth signin to existing local user when both local emailVerified and provider verify', async () => {
      // Seed a local user with a password (provider=local) that has ALREADY verified its email
      // — the branch-3 link-on-verified-email gate requires both sides to vouch (issue #3504).
      const localEmail = 'oauthlink-local@test.com';
      const localUser = await UserService.create({
        firstName: 'Local',
        lastName: 'Link',
        email: localEmail,
        password: credentials[0].password,
        provider: 'local',
        roles: ['user'],
      });
      // Mark the local account as email-verified (done normally by the verification flow).
      const brutLocal = await UserService.getBrut({ email: localEmail });
      await UserService.update(brutLocal, { emailVerified: true }, 'recover');

      // OAuth signin arrives with matching email + provider-verified flag
      const profil = {
        firstName: 'Local',
        lastName: 'Link',
        email: localEmail,
        avatar: '',
        providerData: { sub: 'google-link-sub-12345', email_verified: true },
        emailVerifiedByProvider: true,
      };
      const linked = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');

      expect(linked).toBeDefined();
      expect(linked.id).toBe(localUser.id);
      expect(linked.provider).toBe('local'); // provider kept so password reset still works
      expect(linked.emailVerified).toBe(true);
      // Verify additionalProvidersData was persisted (getBrut bypasses the sanitize whitelist)
      const brutLinked = await UserService.getBrut({ id: linked.id });
      expect(brutLinked.additionalProvidersData?.google?.sub).toBe('google-link-sub-12345');

      // Subsequent signin with the same Google sub should find the linked user via step 2
      const second = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
      expect(second.id).toBe(localUser.id);

      try { await UserService.remove(linked); } catch (_) { /* cleanup */ }
    });

    test('should reject link when local account is NOT emailVerified even if OAuth provider verified (#3504)', async () => {
      // Squatter scenario (issue #3504): someone signed up locally with victim's email
      // but never verified it. A later OAuth signin by the real owner must NOT silently
      // annex the unverified local account.
      const squatterEmail = 'oauthlink-squatter@test.com';
      const localUser = await UserService.create({
        firstName: 'Squatter',
        lastName: 'Pending',
        email: squatterEmail,
        password: credentials[0].password,
        provider: 'local',
        roles: ['user'],
      });
      // Sanity: freshly created local user is not emailVerified by default.
      const brutBefore = await UserService.getBrut({ email: squatterEmail });
      expect(brutBefore.emailVerified).toBe(false);
      expect(brutBefore.additionalProvidersData?.google).toBeUndefined();
      expect(brutBefore.providerData == null).toBe(true);

      const profil = {
        firstName: 'Real',
        lastName: 'Owner',
        email: squatterEmail,
        avatar: '',
        providerData: { sub: 'google-owner-sub-3504', email_verified: true },
        emailVerifiedByProvider: true,
      };

      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'oAuth, cannot link to unverified local account',
      });

      // The unverified local account must be untouched — no silent annexation.
      const users = await UserService.search({ email: squatterEmail });
      expect(users.length).toBe(1);
      const brutAfter = await UserService.getBrut({ email: squatterEmail });
      expect(brutAfter.emailVerified).toBe(false);
      expect(brutAfter.additionalProvidersData?.google).toBeUndefined();
      expect(brutAfter.providerData == null).toBe(true);

      try { await UserService.remove(localUser); } catch (_) { /* cleanup */ }
    });

    test('should NOT link when OAuth provider did not verify the email', async () => {
      const sharedEmail = 'oauthlink-unverified@test.com';
      const localUser = await UserService.create({
        firstName: 'Unverified',
        lastName: 'Link',
        email: sharedEmail,
        password: credentials[0].password,
        provider: 'local',
        roles: ['user'],
      });

      // OAuth arrives for the SAME email but email_verified=false — must not link
      const profil = {
        firstName: 'Unverified',
        lastName: 'Link',
        email: sharedEmail,
        avatar: '',
        providerData: { sub: 'google-unverified-sub-999', email_verified: false },
        emailVerifiedByProvider: false,
      };
      // Falls through to create branch → duplicate email → unique-index error
      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toThrow();
      // Local account must remain untouched — no OAuth data attached
      const untouched = await UserService.getBrut({ email: sharedEmail });
      expect(untouched).toBeDefined();
      expect(untouched.additionalProvidersData?.google).toBeUndefined();

      try { await UserService.remove(localUser); } catch (_) { /* cleanup */ }
    });

    test('should reject link when local email matches but OAuth provider did not verify (no takeover)', async () => {
      const sharedEmail = 'oauthlink-takeover@test.com';
      const localUser = await UserService.create({
        firstName: 'Victim',
        lastName: 'User',
        email: sharedEmail,
        password: credentials[0].password,
        provider: 'local',
        roles: ['user'],
      });

      // Attacker tries OAuth with same email but provider says email_verified=false
      const profil = {
        firstName: 'Attacker',
        lastName: 'User',
        email: sharedEmail,
        avatar: '',
        providerData: { sub: 'google-attacker-sub-42', email_verified: false },
        emailVerifiedByProvider: false,
      };
      // Must error — unverified email falls to create branch → duplicate email → AppError
      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toMatchObject({ code: 'CONTROLLER_ERROR' });
      // Verify the local account was NOT modified — exactly one user with this email, no OAuth data
      const users = await UserService.search({ email: sharedEmail });
      expect(users.length).toBe(1);
      expect(users[0].additionalProvidersData).toBeUndefined();

      try { await UserService.remove(localUser); } catch (_) { /* cleanup */ }
    });

    test('should set emailVerified=true when creating a fresh OAuth user with verified email', async () => {
      const profil = {
        firstName: 'Fresh',
        lastName: 'OAuth',
        email: 'oauth-fresh@test.com',
        avatar: '',
        providerData: { sub: 'google-fresh-sub-55', email_verified: true },
        emailVerifiedByProvider: true,
      };
      const created = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
      expect(created.emailVerified).toBe(true);
      expect(created.provider).toBe('google');

      try { await UserService.remove(created); } catch (_) { /* cleanup */ }
    });

    test('should throw VALIDATION_ERROR for unsupported OAuth provider', async () => {
      const profil = {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
        avatar: '',
        providerData: { sub: 'bad-sub' },
        emailVerifiedByProvider: false,
      };
      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'badprovider'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    test('should throw VALIDATION_ERROR for unsupported provider key', async () => {
      const profil = {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
        avatar: '',
        providerData: { badkey: 'value' },
        emailVerifiedByProvider: false,
      };
      await expect(
        AuthController.checkOAuthUserProfile(profil, 'badkey', 'google'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    describe('signup gate (config.sign.up = false)', () => {
      let originalSignUpConfig;

      beforeEach(() => {
        originalSignUpConfig = config.sign.up;
      });

      afterEach(() => {
        config.sign.up = originalSignUpConfig;
      });

      test('should reject new OAuth user creation when signup is disabled (branch 4)', async () => {
        config.sign.up = false;
        const email = 'oauth-signup-gate-new@test.com';
        const profil = {
          firstName: 'Gated',
          lastName: 'Signup',
          email,
          avatar: '',
          providerData: { sub: 'google-gated-sub-3503' },
          emailVerifiedByProvider: false,
        };
        await expect(
          AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
        ).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          details: { message: 'Registration is currently deactivated' },
        });
        // Ensure no user was persisted
        const users = await UserService.search({ email });
        expect(users.length).toBe(0);
      });

      test('should allow existing OAuth-first user to sign in when signup disabled (branch 1)', async () => {
        const email = 'oauth-signup-gate-b1@test.com';
        const existing = await UserService.create({
          firstName: 'Branch',
          lastName: 'One',
          email,
          provider: 'google',
          providerData: { sub: 'google-gated-b1-sub' },
          roles: ['user'],
        });
        config.sign.up = false;
        const profil = {
          firstName: 'Branch',
          lastName: 'One',
          email,
          avatar: '',
          providerData: { sub: 'google-gated-b1-sub' },
        };
        const found = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
        expect(found).toBeDefined();
        expect(found.id).toBe(existing.id);

        try { await UserService.remove(existing); } catch (_) { /* cleanup */ }
      });

      test('should allow linked OAuth user to sign in when signup disabled (branch 2)', async () => {
        const email = 'oauth-signup-gate-b2@test.com';
        const localUser = await UserService.create({
          firstName: 'Branch',
          lastName: 'Two',
          email,
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
          roles: ['user'],
        });
        // Inject additionalProvidersData to simulate a pre-linked account
        const brutLocal = await UserService.getBrut({ email });
        await UserService.update(brutLocal, {
          additionalProvidersData: {
            google: { sub: 'google-gated-b2-sub', email_verified: true },
          },
        }, 'recover');

        config.sign.up = false;
        const profil = {
          firstName: 'Branch',
          lastName: 'Two',
          email,
          avatar: '',
          providerData: { sub: 'google-gated-b2-sub' },
        };
        const found = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
        expect(found).toBeDefined();
        expect(found.id).toBe(localUser.id);

        try { await UserService.remove(localUser); } catch (_) { /* cleanup */ }
      });

      test('should link local user via verified email when signup disabled (branch 3)', async () => {
        const email = 'oauth-signup-gate-b3@test.com';
        const localUser = await UserService.create({
          firstName: 'Branch',
          lastName: 'Three',
          email,
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
          roles: ['user'],
        });
        // Mark the local account as email-verified — branch 3 link-gate now
        // requires both OAuth provider AND local emailVerified (issue #3504).
        const brutSeed = await UserService.getBrut({ email });
        await UserService.update(brutSeed, { emailVerified: true }, 'recover');

        config.sign.up = false;
        const profil = {
          firstName: 'Branch',
          lastName: 'Three',
          email,
          avatar: '',
          providerData: { sub: 'google-gated-b3-sub', email_verified: true },
          emailVerifiedByProvider: true,
        };
        const linked = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
        expect(linked).toBeDefined();
        expect(linked.id).toBe(localUser.id);
        const brutLinked = await UserService.getBrut({ id: linked.id });
        expect(brutLinked.additionalProvidersData?.google?.sub).toBe('google-gated-b3-sub');

        try { await UserService.remove(linked); } catch (_) { /* cleanup */ }
      });
    });

    test('token endpoint should strip accessToken/refreshToken from additionalProvidersData', async () => {
      // Create a local user then sign in to get an auth cookie
      const localEmail = 'token-sanitize@test.com';
      const localPassword = 'W@os.jsI$Aw3$0m3';
      const localUser = await UserService.create({
        firstName: 'Token',
        lastName: 'Sanitize',
        email: localEmail,
        password: localPassword,
        provider: 'local',
        roles: ['user'],
      });
      // Manually inject additionalProvidersData with tokens (simulating a linked OAuth account)
      const brutUser = await UserService.getBrut({ email: localEmail });
      await UserService.update(brutUser, {
        additionalProvidersData: {
          google: { sub: 'google-sub-sanitize', accessToken: 'secret-token', refreshToken: 'secret-refresh', email_verified: true },
        },
      }, 'recover');

      // Sign in as this user and call the token endpoint (agent persists the session cookie)
      await agent.post('/api/auth/signin').send({ email: localEmail, password: localPassword }).expect(200);
      const tokenResult = await agent.get('/api/auth/token').expect(200);

      expect(tokenResult.body.user.additionalProvidersData?.google?.sub).toBe('google-sub-sanitize');
      expect(tokenResult.body.user.additionalProvidersData?.google?.accessToken).toBeUndefined();
      expect(tokenResult.body.user.additionalProvidersData?.google?.refreshToken).toBeUndefined();

      try { await UserService.remove(localUser); } catch (_) { /* cleanup */ }
    });

    afterAll(async () => {
      for (const u of oauthUsers) {
        try {
          await UserService.remove(u);
        } catch (_) { /* cleanup – ignore errors */ }
      }
    });
  });

  describe('Password reset endpoint', () => {
    beforeEach(async () => {
      credentials = [
        {
          email: 'resetpwd@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        },
      ];
      _user = {
        firstName: 'Reset',
        lastName: 'User',
        email: credentials[0].email,
        password: credentials[0].password,
        provider: 'local',
      };
      // clean up stale users from previous runs on shared databases
      try {
        const existing = await UserService.getBrut({ email: credentials[0].email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 400 when token or password fields are missing', async () => {
      try {
        const result = await agent.post('/api/auth/reset').send({ newPassword: 'NewP@ss123' }).expect(400);
        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Password or Token fields must not be blank');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 400 when reset token is invalid or not found', async () => {
      try {
        const result = await agent.post('/api/auth/reset').send({ token: 'invalid-token-xyz', newPassword: 'NewP@ss!Word123' }).expect(400);
        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Password reset token is invalid or has expired.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should successfully reset password with a valid token', async () => {
      // Trigger forgot to generate a reset token (email send fails in test env, which is expected)
      try {
        await agent.post('/api/auth/forgot').send({ email: credentials[0].email }).expect(400);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Fetch the token directly via UserService
      let resetToken;
      try {
        const userWithToken = await UserService.getBrut({ email: credentials[0].email });
        resetToken = userWithToken.resetPasswordToken;
        expect(resetToken).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Reset password with the valid token
      try {
        const result = await agent.post('/api/auth/reset').send({ token: resetToken, newPassword: 'NewP@ss!Word123' }).expect(200);
        expect(result.body.message).toBe('Password changed successfully');
        expect(result.body.user).toBeDefined();
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
  });

  describe('Security', () => {
    const secEmail = 'security@test.com';
    const secPassword = 'W@os.jsI$Aw3$0m3';
    let secUser;

    beforeEach(async () => {
      // clean up stale users from previous runs on shared databases
      for (const email of [secEmail, 'cookieflag@test.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup – ignore errors */ }
      }
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Sec',
          lastName: 'Test',
          email: secEmail,
          password: secPassword,
          provider: 'local',
        }).expect(200);
        secUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('signup cookie should have HttpOnly and SameSite=Strict flags', async () => {
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Cookie',
          lastName: 'Test',
          email: 'cookieflag@test.com',
          password: secPassword,
          provider: 'local',
        }).expect(200);
        const tokenCookie = result.headers['set-cookie']?.find((c) => c.startsWith('TOKEN='));
        expect(tokenCookie).toBeDefined();
        expect(tokenCookie).toMatch(/HttpOnly/i);
        expect(tokenCookie).toMatch(/SameSite=Strict/i);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('signin cookie should have HttpOnly and SameSite=Strict flags', async () => {
      try {
        const result = await agent.post('/api/auth/signin').send({ email: secEmail, password: secPassword }).expect(200);
        const tokenCookie = result.headers['set-cookie']?.find((c) => c.startsWith('TOKEN='));
        expect(tokenCookie).toBeDefined();
        expect(tokenCookie).toMatch(/HttpOnly/i);
        expect(tokenCookie).toMatch(/SameSite=Strict/i);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('rate-limited auth routes should include RateLimit response headers', async () => {
      try {
        const result = await agent.post('/api/auth/signin').send({ email: secEmail, password: secPassword }).expect(200);
        expect(result.headers['ratelimit-limit']).toBeDefined();
        expect(result.headers['ratelimit-remaining']).toBeDefined();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      try { if (secUser) await UserService.remove(secUser); } catch (_) { /* cleanup */ }
      try {
        const cookieUser = await UserService.getBrut({ email: 'cookieflag@test.com' });
        if (cookieUser) await UserService.remove(cookieUser);
      } catch (_) { /* cleanup */ }
      secUser = null;
    });
  });

  describe('Error paths', () => {
    test('should redirect to invalid when validateResetToken getBrut throws', async () => {
      jest.spyOn(UserService, 'getBrut').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/auth/reset/sometoken').expect(302);
      expect(result.headers.location).toBe('/api/password/reset/invalid');
    });

    test('should return 500 when local strategy authenticate throws an unexpected error', async () => {
      const spy = jest.spyOn(AuthService, 'authenticate').mockRejectedValueOnce(new Error('DB failure'));
      await agent.post('/api/auth/signin').send({ email: 'a@b.com', password: 'pass' }).expect(500);
      spy.mockRestore();
    });
  });

  describe('Config endpoint', () => {
    test('should return sign flags reflecting current config', async () => {
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data).toMatchObject({
        sign: {
          in: expect.any(Boolean),
          up: expect.any(Boolean),
        },
        organizations: {
          enabled: expect.any(Boolean),
          domainMatching: expect.any(Boolean),
        },
      });
    });

    test('should return false when sign.up is disabled', async () => {
      const original = config.sign.up;
      config.sign.up = false;
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.sign.up).toBe(false);
      config.sign.up = original;
    });

    test('should return false when sign.in is disabled', async () => {
      const original = config.sign.in;
      config.sign.in = false;
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.sign.in).toBe(false);
      config.sign.in = original;
    });

    test('should return organizations config with enabled and domainMatching', async () => {
      const original = config.organizations.enabled;
      config.organizations.enabled = true;
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.organizations).toBeDefined();
      expect(result.body.data.organizations.enabled).toBe(true);
      expect(typeof result.body.data.organizations.domainMatching).toBe('boolean');
      config.organizations.enabled = original;
    });

    test('should expose autoCreate in organizations config', async () => {
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.organizations.autoCreate).toBeDefined();
    });

    test('should reflect organizations.enabled=false when disabled', async () => {
      const original = config.organizations.enabled;
      config.organizations.enabled = false;
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.organizations.enabled).toBe(false);
      config.organizations.enabled = original;
    });

    test('should reflect organizations.enabled=true when enabled', async () => {
      const original = config.organizations.enabled;
      config.organizations.enabled = true;
      const result = await agent.get('/api/auth/config').expect(200);
      expect(result.body.data.organizations.enabled).toBe(true);
      config.organizations.enabled = original;
    });
  });

  describe('Email verification', () => {
    const verifyEmail = 'verify@test.com';
    const verifyPassword = 'W@os.jsI$Aw3$0m3';
    let verifyUser;

    beforeEach(async () => {
      // clean up stale users from previous runs on shared databases
      try {
        const existing = await UserService.getBrut({ email: verifyEmail });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Verify',
          lastName: 'Test',
          email: verifyEmail,
          password: verifyPassword,
          provider: 'local',
        }).expect(200);
        verifyUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should auto-verify email when mailer is not configured', async () => {
      // In test env, mailer.from starts with DEVKIT_NODE_ so it is treated as unconfigured
      try {
        const dbUser = await UserService.getBrut({ email: verifyEmail });
        expect(dbUser.emailVerified).toBe(true);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return emailVerified true in signup response when auto-verified', async () => {
      expect(verifyUser.emailVerified).toBe(true);
    });

    test('should return 400 for invalid verification token', async () => {
      try {
        const result = await agent.post('/api/auth/verify-email/invalid-token-xyz').expect(400);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Bad Request');
        expect(result.body.description).toBe('Email verification token is invalid or has expired.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should verify email with a valid token', async () => {
      // Manually set a verification token to simulate mailer-configured flow
      try {
        const dbUser = await UserService.getBrut({ email: verifyEmail });
        dbUser.emailVerified = false;
        dbUser.emailVerificationToken = 'valid-test-token-123';
        dbUser.emailVerificationExpires = new Date(Date.now() + 24 * 3600000);
        await dbUser.save();

        const result = await agent.post('/api/auth/verify-email/valid-test-token-123').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('Email verified successfully');
        expect(result.body.data.emailVerified).toBe(true);

        const updatedUser = await UserService.getBrut({ email: verifyEmail });
        expect(updatedUser.emailVerified).toBe(true);
        expect(updatedUser.emailVerificationToken).toBeNull();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 400 for expired verification token', async () => {
      try {
        const dbUser = await UserService.getBrut({ email: verifyEmail });
        dbUser.emailVerified = false;
        dbUser.emailVerificationToken = 'expired-test-token-456';
        dbUser.emailVerificationExpires = new Date(Date.now() - 1000); // expired
        await dbUser.save();

        const result = await agent.post('/api/auth/verify-email/expired-test-token-456').expect(400);
        expect(result.body.type).toBe('error');
        expect(result.body.description).toBe('Email verification token is invalid or has expired.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 400 when resending verification for already verified email', async () => {
      try {
        // Sign in to get auth cookie
        await agent.post('/api/auth/signin').send({ email: verifyEmail, password: verifyPassword }).expect(200);
        const result = await agent.post('/api/auth/resend-verification').expect(400);
        expect(result.body.type).toBe('error');
        expect(result.body.description).toBe('Email is already verified');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 400 when resending verification but mailer is not configured', async () => {
      try {
        const dbUser = await UserService.getBrut({ email: verifyEmail });
        dbUser.emailVerified = false;
        await dbUser.save();

        await agent.post('/api/auth/signin').send({ email: verifyEmail, password: verifyPassword }).expect(200);
        const result = await agent.post('/api/auth/resend-verification').expect(400);
        expect(result.body.type).toBe('error');
        expect(result.body.description).toBe('Mail service is not configured');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      try {
        if (verifyUser) await UserService.remove(verifyUser);
      } catch (_) { /* cleanup */ }
      verifyUser = null;
    });
  });

  describe('Account lockout', () => {
    const lockEmail = 'lockout@test.com';
    const lockPassword = 'W@os.jsI$Aw3$0m3';
    let lockUser;

    beforeEach(async () => {
      // clean up stale users from previous runs on shared databases
      try {
        const existing = await UserService.getBrut({ email: lockEmail });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Lock',
          lastName: 'Test',
          email: lockEmail,
          password: lockPassword,
          provider: 'local',
        }).expect(200);
        lockUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should update lastLoginAt on successful login', async () => {
      try {
        await agent.post('/api/auth/signin').send({ email: lockEmail, password: lockPassword }).expect(200);
        const dbUser = await UserService.getBrut({ email: lockEmail });
        expect(dbUser.lastLoginAt).toBeDefined();
        expect(dbUser.lastLoginAt).toBeInstanceOf(Date);
        expect(dbUser.failedLoginAttempts).toBe(0);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should increment failedLoginAttempts on wrong password', async () => {
      try {
        await agent.post('/api/auth/signin').send({ email: lockEmail, password: 'WrongP@ss123' }).expect(401);
        const dbUser = await UserService.getBrut({ email: lockEmail });
        expect(dbUser.failedLoginAttempts).toBe(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should lock account after max failed attempts and return 423', async () => {
      const maxAttempts = config.auth?.lockout?.maxAttempts ?? 5;
      try {
        for (let i = 0; i < maxAttempts; i++) {
          await agent.post('/api/auth/signin').send({ email: lockEmail, password: 'WrongP@ss123' });
        }
        const dbUser = await UserService.getBrut({ email: lockEmail });
        expect(dbUser.failedLoginAttempts).toBe(maxAttempts);
        expect(dbUser.lockUntil).toBeDefined();
        expect(dbUser.lockUntil).toBeInstanceOf(Date);
        expect(dbUser.lockUntil.getTime()).toBeGreaterThan(Date.now());
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Now a valid login should be rejected with 423
      try {
        const result = await agent.post('/api/auth/signin').send({ email: lockEmail, password: lockPassword }).expect(423);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Account locked');
        expect(result.body.description).toMatch(/locked/i);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should allow login after lock expires', async () => {
      const maxAttempts = config.auth?.lockout?.maxAttempts ?? 5;
      try {
        for (let i = 0; i < maxAttempts; i++) {
          await agent.post('/api/auth/signin').send({ email: lockEmail, password: 'WrongP@ss123' });
        }
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Manually set lockUntil to a past date to simulate expiry
      try {
        const dbUser = await UserService.getBrut({ email: lockEmail });
        dbUser.lockUntil = new Date(Date.now() - 1000);
        await dbUser.save();
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Should now be able to login successfully
      try {
        const result = await agent.post('/api/auth/signin').send({ email: lockEmail, password: lockPassword }).expect(200);
        expect(result.body.user.email).toBe(lockEmail);

        const dbUser = await UserService.getBrut({ email: lockEmail });
        expect(dbUser.failedLoginAttempts).toBe(0);
        expect(dbUser.lockUntil).toBeNull();
        expect(dbUser.lastLoginAt).toBeInstanceOf(Date);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      try {
        if (lockUser) await UserService.remove(lockUser);
      } catch (_) { /* cleanup */ }
      lockUser = null;
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
