/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import _ from 'lodash';
import { jest } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Unit tests
 */
describe('User admin integration tests:', () => {
  let UserService = null;
  let agent;
  let credentials;
  let user;
  let userEdited;
  let _user;
  let _userEdited;

  /**
   * Helper: sign up a user and promote to admin via service layer.
   * Roles are stripped from signup for security, so admin promotion
   * must happen server-side after account creation.
   */
  const signupAndPromoteAdmin = async (agentInstance, body) => {
    const safeBody = { ...body };
    delete safeBody.roles;
    const result = await agentInstance.post('/api/auth/signup').send(safeBody).expect(200);
    const created = result.body.user;
    const brut = await UserService.getBrut({ id: created.id || created._id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');
    return created;
  };

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
  describe('Logged', () => {
    beforeEach(async () => {
      // users credentials
      credentials = [
        {
          email: 'admin@test.com',
          password: 'W@os.jsI$Aw3$0m3',
        },
        {
          email: 'admin2@test.com',
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

    test('should not be able to retrieve a list of users if not admin', async () => {
      try {
        const result = await agent.get('/api/admin/users').expect(403);
        expect(result.body.message).toBe('Unauthorized');
        expect(result.body.description).toBe('User is not authorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve a list of users if admin', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get('/api/admin/users').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user list');
        expect(result.body.data).toBeInstanceOf(Array);
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

    test('should be able to retrieve a list of users if admin with pagination', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get('/api/admin/users/page/0').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user list');
        expect(result.body.data).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get('/api/admin/users/page/0&1').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user list');
        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data).toHaveLength(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get('/api/admin/users/page/1&1').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user list');
        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data).toHaveLength(1);
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

    test('should be able to retrieve a list of users if admin with pagination and search', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get('/api/admin/users/page/0&20&Admin').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user list');
        expect(result.body.data).toBeInstanceOf(Array);
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

    test('should be able to get a single user details if admin', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get(`/api/admin/users/${userEdited._id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user get');
        expect(result.body.data).toBeInstanceOf(Object);
        expect(result.body.data._id).toBe(String(userEdited._id));
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

    test('should not expose sensitive fields (password, tokens) in admin GET /users/:id', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // Seed token fields so the regression test is meaningful — without this,
      // the assertions pass vacuously because the fields are simply absent.
      try {
        await UserService.updateById(userEdited._id, {
          resetPasswordToken: 'test-reset-token',
          emailVerificationToken: 'test-verification-token',
        });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.get(`/api/admin/users/${userEdited._id}`).expect(200);
        expect(result.body.data).toBeInstanceOf(Object);
        expect(result.body.data.password).toBeUndefined();
        expect(result.body.data.resetPasswordToken).toBeUndefined();
        expect(result.body.data.emailVerificationToken).toBeUndefined();
        expect(result.body.data.salt).toBeUndefined();
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

    test('should be able to update a single user details if admin', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const userUpdate = {
          firstName: 'admin_update_first',
          lastName: 'admin_update_last',
          roles: ['admin'],
        };

        const result = await agent.put(`/api/admin/users/${userEdited._id}`).send(userUpdate).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user updated');
        expect(result.body.data).toBeInstanceOf(Object);
        expect(result.body.data.firstName).toBe('admin_update_first');
        expect(result.body.data.lastName).toBe('admin_update_last');
        expect(result.body.data.roles).toBeInstanceOf(Array);
        expect(result.body.data.roles).toHaveLength(1);
        expect(result.body.data.roles).toEqual(expect.arrayContaining(['admin']));
        expect(result.body.data._id).toBe(String(userEdited._id));
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

    // P8a / E20: referredBy is a server-only referral field — even an admin update
    // (config.whitelists.users.updateAdmin) must NOT persist it from the request body.
    // It is absent from updateAdmin, so removeSensitive strips it. Proves the admin
    // whitelist blocks it too (mirrors the self-update negative test).
    test('should NOT persist referredBy via the admin user-update path (server-only)', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const userUpdate = {
          firstName: 'admin_ref_first',
          referredBy: '64b2f0000000000000000def', // attacker-supplied referrer id
        };
        const result = await agent.put(`/api/admin/users/${userEdited._id}`).send(userUpdate).expect(200);
        expect(result.body.data.firstName).toBe('admin_ref_first');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        // Raw read — the whitelisted firstName landed, referredBy did NOT.
        const result = await UserService.getBrut({ id: userEdited._id });
        expect(result.firstName).toBe('admin_ref_first');
        expect(result.referredBy == null).toBe(true);
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

    test('should be able to remove a single user if admin', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await agent.delete(`/api/admin/users/${userEdited._id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('user deleted');
        expect(result.body.data).toBeInstanceOf(Object);
        expect(result.body.data.id).toBe(String(userEdited._id));
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

    test('should return 404 when getting a user with a non-existent id if admin', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        // Valid ObjectId format but non-existent user
        const result = await agent.get('/api/admin/users/000000000000000000000000').expect(404);
        expect(result.body.message).toBe('Not Found');
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

    test('should return 422 when pagination params exceed maximum of 3', async () => {
      try {
        userEdited = await signupAndPromoteAdmin(agent, { ..._userEdited, roles: ['user', 'admin'] });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        // 4 params separated by & exceeds the allowed max of 3
        const result = await agent.get('/api/admin/users/page/0&10&search&extra').expect(422);
        expect(result.body.message).toBeDefined();
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

    afterEach(async () => {
      // del user
      try {
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Errors', () => {
    let adminUser;
    let targetUser;

    beforeAll(async () => {
      try {
        const targetResult = await agent.post('/api/auth/signup').send({
          firstName: 'Target',
          lastName: 'Error',
          email: 'admintarget@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        targetUser = targetResult.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      try {
        adminUser = await signupAndPromoteAdmin(agent, {
          firstName: 'Admin',
          lastName: 'Error',
          email: 'adminerror@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 422 when list fails', async () => {
      jest.spyOn(UserService, 'list').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/admin/users').expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when admin update fails', async () => {
      jest.spyOn(UserService, 'update').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.put(`/api/admin/users/${targetUser._id}`).send({ firstName: 'X' }).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when admin remove fails', async () => {
      jest.spyOn(UserService, 'remove').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.delete(`/api/admin/users/${targetUser._id}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    afterAll(async () => {
      try {
        await UserService.remove(targetUser);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        await UserService.remove(adminUser);
      } catch (_) { /* cleanup – ignore errors */ }
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
