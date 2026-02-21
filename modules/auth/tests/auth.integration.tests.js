/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import _ from 'lodash';
import { jest } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Unit tests
 */
describe('Auth integration tests:', () => {
  let UserService = null;
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
        expect(result.error.text).toBe('Unauthorized');
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
        expect(result.error.text).toBe('Unauthorized');
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
        const result = await UserService.get({
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
        const result = await UserService.get({
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
        const result = await UserService.get({
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
      const mockRes = { status() { return this; }, json() {}, cookie() { return this; } };
      const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google', mockRes);
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.email).toBe(profil.email);
      oauthUsers.push(result);
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
      const mockRes = { status() { return this; }, json() {}, cookie() { return this; } };
      // Second call — should find the existing user (search.length === 1 branch)
      const found = await AuthController.checkOAuthUserProfile(profil, 'id', 'google', mockRes);
      expect(found).toBeDefined();

      // cleanup
      try {
        await UserService.remove(createdUser);
      } catch (_) { /* cleanup – ignore errors */ }
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
