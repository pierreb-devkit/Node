/**
 * Module dependencies.
 */
import path from 'path';

import { jest } from '@jest/globals';
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';
import mongooseService from '../../../lib/services/mongoose.js';
import seed from '../../../lib/services/seed.js';

import { bootstrap } from '../../../lib/app.js';

/**
 * Unit tests
 */
describe('Core integration tests:', () => {
  let AuthService;
  let UserService;
  let TaskService;

  beforeAll(async () => {
    try {
      await bootstrap();
      AuthService = (await import(path.resolve('./modules/auth/services/auth.service.js'))).default;
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      TaskService = (await import(path.resolve('./modules/tasks/services/tasks.service.js'))).default;
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  let user1;
  let admin1;
  let userFromSeedConfig;
  let adminFromSeedConfig;

  describe('SeedDB', () => {
    beforeAll((done) => {
      user1 = {
        provider: 'local',
        email: 'user_config_test_@localhost.com',
        firstName: 'User',
        lastName: 'Local',
        roles: ['user'],
      };

      admin1 = {
        provider: 'local',
        email: 'admin_config_test_@localhost.com',
        firstName: 'Admin',
        lastName: 'Local',
        roles: ['user', 'admin'],
      };

      userFromSeedConfig = config.seedDB.options.seedUser;
      adminFromSeedConfig = config.seedDB.options.seedAdmin;
      done();
    });

    it('should seed ONLY the admin user account when NODE_ENV is set to "production"', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      let result;

      try {
        result = await seed.start({ logResults: false }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should seed admin, user accounts when NODE_ENV is set to "test"', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      let result;

      try {
        result = await seed.start({ logResults: false }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(2);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
        await UserService.remove({ id: result[1]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should seed admin, user accounts  and tasks when NODE_ENV is set to "development"', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      let result;

      try {
        result = await seed.start({ logResults: false }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(4);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
        await UserService.remove({ id: result[1]._id });
        await TaskService.remove({ id: result[2]._id });
        await TaskService.remove({ id: result[3]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should seed admin, and "regular" user accounts when NODE_ENV is set to "test" when they already exist', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      let _user;
      let _admin;
      let result;

      try {
        _user = await UserService.create(userFromSeedConfig);
        _admin = await UserService.create(adminFromSeedConfig);
        expect(_user).toBeInstanceOf(Object);
        expect(_admin).toBeInstanceOf(Object);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        const result = await UserService.search({ email: { $in: [adminFromSeedConfig.email, userFromSeedConfig.email] } });
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(2);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        result = await seed.start({ logResults: false }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(2);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
        await UserService.remove({ id: result[1]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should ONLY seed admin user account when NODE_ENV is set to "production" with custom admin', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      let result;

      try {
        result = await seed.start({ logResults: false, seedAdmin: admin1 }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(1);
        expect(result[0].email).toBe(admin1.email);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should seed admin, and "regular" user accounts when NODE_ENV is set to "test" with custom options', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      let result;

      try {
        result = await seed.start({ logResults: false, seedAdmin: admin1, seedUser: user1 }, UserService, AuthService, TaskService);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(2);
        expect(result[0].email).toBe(user1.email);
        expect(result[1].email).toBe(admin1.email);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        await UserService.remove({ id: result[0]._id });
        await UserService.remove({ id: result[1]._id });
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });

    it('should NOT seed admin user account if it already exists when NODE_ENV is set to "production"', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      let _admin;
      let result;

      try {
        _admin = await UserService.create(adminFromSeedConfig);
        expect(_admin).toBeInstanceOf(Object);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      try {
        result = await seed.start({ logResults: false }, UserService, AuthService, TaskService);
        expect(result[0].details[0].message).toBe('Failed due to local account already exists: seedadmin@localhost.com');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      process.env.NODE_ENV = nodeEnv;
    });
  });

  describe('Seed service', () => {
    it('should log results when logResults option is enabled', async () => {
      const loggerSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

      const result = await seed.start({ logResults: true }, UserService, AuthService, TaskService);

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Database Seeding'));
      expect(result).toBeInstanceOf(Array);
      loggerSpy.mockRestore();
    });

    it('should seed a single user via seed.user()', async () => {
      const seedUser = {
        firstName: 'Seed',
        lastName: 'Test',
        email: 'seedtest@unit.com',
        provider: 'local',
        roles: ['user'],
      };

      const result = await seed.user(seedUser, UserService, AuthService);
      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);

      // cleanup
      try {
        await UserService.remove(result[0]);
      } catch (_) { /* cleanup – ignore errors */ }
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });
});
