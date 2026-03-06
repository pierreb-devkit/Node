/**
 * Module dependencies.
 */
import _ from 'lodash';
import path from 'path';
import { jest } from '@jest/globals';

import assets from '../../../config/assets.js';
import config from '../../../config/index.js';
import configHelper from '../../../lib/helpers/config.js';
import logger from '../../../lib/services/logger.js';
import mongooseService from '../../../lib/services/mongoose.js';
import expressService from '../../../lib/services/express.js';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import AppError from '../../../lib/helpers/AppError.js';
import policy from '../../../lib/middlewares/policy.js';

/**
 * Unit tests
 */
describe('Core unit tests:', () => {
  let userFromSeedConfig;
  let adminFromSeedConfig;
  let tasksFromSeedConfig;

  let originalLogConfig;

  describe('Configurations', () => {
    it('config generator should return an array of globbed paths', async () => {
      const globPatterns = ['test/**/*.js'];
      const result = await configHelper.getGlobbedPaths(globPatterns);
      expect(Array.isArray(result)).toBe(true);
    });

    it('config generator should log a warning if config.domain is not set', () => {
      const consoleSpy = jest.spyOn(console, 'log');
      const config = { domain: null };
      configHelper.validateDomainIsSet(config);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Important warning: config.domain is empty'));
      consoleSpy.mockRestore();
    });

    it('config generator should return an object with files', async () => {
      const assets = {
        allYaml: 'test/**/*.yaml',
        mongooseModels: 'test/**/*.model.js',
        sequelizeModels: 'test/**/*.model.js',
        routes: 'test/**/*.routes.js',
        config: 'test/**/*.config.js',
        policies: 'test/**/*.policies.js',
      };
      const result = await configHelper.initGlobalConfigFiles(assets);
      expect(typeof result).toBe('object');
    });

    it('assets should contain the correct keys', () => {
      const expectedKeys = ['allJS', 'allYaml', 'mongooseModels', 'sequelizeModels', 'routes', 'config', 'policies'];

      expectedKeys.forEach((key) => {
        expect(assets).toHaveProperty(key);
      });
    });

    it('config should load production configuration in production env', async () => {
      try {
        const defaultConfig = (await import(path.join(process.cwd(), './config', 'defaults', 'production.js'))) || {};
        expect(defaultConfig.default.app.title.split(' - ')[1]).toBe('Production Environment');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  describe('SeedDB', () => {
    beforeAll((done) => {
      userFromSeedConfig = config.seedDB.options.seedUser;
      adminFromSeedConfig = config.seedDB.options.seedAdmin;
      tasksFromSeedConfig = config.seedDB.options.seedTasks;
      done();
    });

    it('should have seedDB configuration set for user', (done) => {
      expect(userFromSeedConfig).toBeInstanceOf(Object);
      expect(typeof userFromSeedConfig.email).toBe('string');
      done();
    });

    it('should have seedDB configuration set for admin user', (done) => {
      expect(userFromSeedConfig).toBeInstanceOf(Object);
      expect(typeof adminFromSeedConfig.email).toBe('string');
      done();
    });

    it('should have seedDB configuration set for tasks', (done) => {
      expect(tasksFromSeedConfig).toBeInstanceOf(Array);
      expect(typeof tasksFromSeedConfig[0].title).toBe('string');
      expect(typeof tasksFromSeedConfig[1].title).toBe('string');
      done();
    });
  });

  describe('Logger', () => {
    beforeEach(() => {
      originalLogConfig = _.clone(config.log, true);
    });

    afterEach(() => {
      config.log = originalLogConfig;
    });

    it('should retrieve the log format from the logger configuration', () => {
      config.log = {
        format: 'tiny',
      };

      const format = logger.getLogFormat();
      expect(format).toBe('tiny');
    });

    it('should retrieve the log options from the logger configuration for a valid stream object', () => {
      const options = logger.getMorganOptions();

      expect(options).toBeInstanceOf(Object);
      expect(options.stream).toBeDefined();
    });

    it('should use the default log format of "combined" when an invalid format was provided', async () => {
      // manually set the config log format to be invalid
      config.log = {
        format: '_some_invalid_format_',
      };

      const format = logger.getLogFormat();
      expect(format).toBe('combined');
    });

    it('should verify that a file logger object was created using the logger configuration', () => {
      const _dir = process.cwd();
      const _filename = 'unit-test-access.log';

      config.log = {
        fileLogger: {
          directoryPath: _dir,
          fileName: _filename,
        },
      };

      const fileTransport = logger.getLogOptions(config);
      expect(fileTransport).toBeInstanceOf(Object);
      expect(fileTransport.filename).toBe(`${_dir}/${_filename}`);
    });

    it('should not create a file transport object if critical options are missing: filename', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      config.log = {
        format: 'combined',
        options: {
          stream: {
            directoryPath: process.cwd(),
            fileName: '',
          },
        },
      };

      const fileTransport = logger.setupFileLogger(config);
      expect(fileTransport).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should not create a file transport object if critical options are missing: directory', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      config.log = {
        format: 'combined',
        options: {
          stream: {
            directoryPath: '',
            fileName: 'app.log',
          },
        },
      };

      const fileTransport = logger.setupFileLogger(config);
      expect(fileTransport).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('Multer', () => {
    it('should be able to get multer avatar configuration', () => {
      const userAvatarConfig = config.uploads.avatar;
      expect(userAvatarConfig).toBeDefined();
      expect(userAvatarConfig.formats).toBeInstanceOf(Array);
      expect(userAvatarConfig.limits.fileSize).toBe(52428.8);
    });
  });

  describe('Errors', () => {
    it('should return errors message properly', async () => {
      try {
        const fromCode = errors.getMessage({ code: 11001, errmsg: 'test' });
        expect(fromCode).toBe('Test already exists.');

        const fromCode2 = errors.getMessage({ code: 11001, errmsg: 'test.$.test' });
        expect(fromCode2).toBe('Test.$ already exists.');

        const fromCodeUnknow = errors.getMessage({ code: 'unknow' });
        expect(fromCodeUnknow).toBe('Something went wrong.');

        const fromErrorsArray = errors.getMessage({ errors: [{ message: 'error1' }, { message: 'error2' }] });
        expect(fromErrorsArray).toBe('error1 error2 .');

        const fromErrorsObject = errors.getMessage({ errors: { one: { message: 'error1' }, two: { message: 'error2' } } });
        expect(fromErrorsObject).toBe('error1 error2 .');

        const fromMessage = errors.getMessage({ message: 'error1' });
        expect(fromMessage).toBe('error1.');

        const fromEmpty = errors.getMessage({});
        expect(fromEmpty).toBe('Something went wrong.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    it('should sanitize unknown errors message', () => {
      const fromUnknown = errors.getMessage({ random: 'value' });
      expect(fromUnknown).toBe('Something went wrong.');
    });
  });

  describe('Responses', () => {
    it('should return success payload and send HTTP 200', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const payload = { ok: true };

      const result = responses.success(mockRes, 'Done')(payload);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(result).toEqual({
        type: 'success',
        message: 'Done',
        data: payload,
      });
    });

    it('should return explicit status and domain code in error response', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const err = new AppError('Schema validation error', {
        status: 422,
        code: 'VALIDATION_ERROR',
        details: { message: 'First name is required.' },
      });

      const result = responses.error(mockRes)(err);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(result.type).toBe('error');
      expect(result.status).toBe(422);
      expect(result.code).toBe(422);
      expect(result.errorCode).toBe('VALIDATION_ERROR');
      expect(result.description).toBe('First name is required.');
    });

    it('should use AppError default details array as response description', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const err = new AppError('From default details', {
        status: 400,
        code: 'VALIDATION_ERROR',
      });

      const result = responses.error(mockRes)(err);

      expect(result.description).toBe('From default details');
    });

    it('should ignore invalid entries in details array and keep valid messages', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const result = responses.error(mockRes, 400, undefined, undefined)({
        code: 'VALIDATION_ERROR',
        details: [null, { message: 'one' }, {}, 'two'],
      });

      expect(result.description).toBe('one, two');
    });

    it('should fallback to error statusCode and explicit description field', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const result = responses.error(mockRes, undefined, undefined, undefined)({
        statusCode: 409,
        code: 'CONFLICT_ERROR',
        description: 'Conflict',
      });

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(result.status).toBe(409);
      expect(result.errorCode).toBe('CONFLICT_ERROR');
      expect(result.description).toBe('Conflict');
    });

    it('should fallback to numeric error.code as http status when needed', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const result = responses.error(mockRes, undefined, undefined, undefined)({
        code: 401,
      });

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(result.status).toBe(401);
      expect(result.errorCode).toBe('SERVER_ERROR');
    });

    it('should fallback to 500 and empty description for unknown error shape', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      const result = responses.error(mockRes)({});

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(result.status).toBe(500);
      expect(result.message).toBe('Something went wrong.');
      expect(result.description).toBe('');
    });

    it('should safely serialize circular error objects in non production', () => {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const circular = {};
      circular.self = circular;

      const result = responses.error(mockRes, 500, 'Boom', '')(circular);

      expect(result.error).toContain('Unserializable error object');
    });

    it('should not expose raw error payload in production mode', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';

        const mockRes = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn(),
        };
        const result = responses.error(mockRes, 422, 'Schema validation error', 'Invalid payload')({
          details: { internal: 'secret' },
        });

        expect(result.error).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  describe('Config helpers', () => {
    it('should return URL as-is when globPattern is a URL', async () => {
      const result = await configHelper.getGlobbedPaths('http://example.com/resource');
      expect(result).toContain('http://example.com/resource');
    });

    it('should apply string excludes when provided to getGlobbedPaths', async () => {
      const result = await configHelper.getGlobbedPaths('modules/core/tests/*.js', 'modules/core/tests/');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should apply array excludes when provided to getGlobbedPaths', async () => {
      const result = await configHelper.getGlobbedPaths('modules/*/tests/*.js', ['core.unit']);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      result.forEach((file) => {
        expect(file).not.toContain('core.unit');
      });
    });

    it('should disable ssl when key/cert paths are not configured', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const fakeConfig = { secure: { ssl: true } };
      configHelper.initSecureMode(fakeConfig);
      expect(fakeConfig.secure.ssl).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should log a warning and disable ssl when cert files are missing', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const fakeConfig = { secure: { ssl: true, key: './nonexistent.pem', cert: './nonexistent2.pem' } };
      configHelper.initSecureMode(fakeConfig);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Certificate file'));
      expect(fakeConfig.secure.ssl).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should return true early when ssl is not configured', () => {
      const result = configHelper.initSecureMode({ secure: { ssl: false } });
      expect(result).toBe(true);
    });
  });

  describe('Express service', () => {
    it('should set app.locals.secure when ssl is enabled', () => {
      const originalSecure = config.secure;
      config.secure = { ssl: true };
      const mockApp = { locals: {}, use: jest.fn() };
      expressService.initLocalVariables(mockApp);
      expect(mockApp.locals.secure).toBe(true);
      config.secure = originalSecure;
    });

    it('should not set app.locals.secure when ssl is disabled', () => {
      const originalSecure = config.secure;
      config.secure = { ssl: false };
      const mockApp = { locals: {}, use: jest.fn() };
      expressService.initLocalVariables(mockApp);
      expect(mockApp.locals.secure).toBeUndefined();
      config.secure = originalSecure;
    });

    it('should call next() when error middleware receives no error', () => {
      const mockApp = { use: jest.fn() };
      expressService.initErrorRoutes(mockApp);
      const middleware = mockApp.use.mock.calls[0][0];
      const mockNext = jest.fn();
      const mockRes = { status: jest.fn().mockReturnThis(), send: jest.fn() };
      middleware(null, {}, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should respond with 500 when error has no status code', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const mockApp = { use: jest.fn() };
      expressService.initErrorRoutes(mockApp);
      const middleware = mockApp.use.mock.calls[0][0];
      const mockNext = jest.fn();
      const mockSend = jest.fn();
      const mockStatus = jest.fn().mockReturnValue({ send: mockSend });
      const mockRes = { status: mockStatus };
      const err = new Error('test error');
      middleware(err, {}, mockRes, mockNext);
      expect(mockStatus).toHaveBeenCalledWith(500);
      consoleSpy.mockRestore();
    });

    it('should respond with the error status code when provided', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const mockApp = { use: jest.fn() };
      expressService.initErrorRoutes(mockApp);
      const middleware = mockApp.use.mock.calls[0][0];
      const mockSend = jest.fn();
      const mockStatus = jest.fn().mockReturnValue({ send: mockSend });
      const mockRes = { status: mockStatus };
      const err = new Error('not found');
      err.status = 404;
      middleware(err, {}, mockRes, jest.fn());
      expect(mockStatus).toHaveBeenCalledWith(404);
      consoleSpy.mockRestore();
    });
  });

  describe('Policy', () => {
    beforeAll(async () => {
      const [homePolicy, tasksPolicy, uploadsPolicy, usersAccountPolicy, usersAdminPolicy] = await Promise.all([
        import('../../../modules/home/policies/home.policy.js'),
        import('../../../modules/tasks/policies/tasks.policy.js'),
        import('../../../modules/uploads/policies/uploads.policy.js'),
        import('../../../modules/users/policies/users.account.policy.js'),
        import('../../../modules/users/policies/users.admin.policy.js'),
      ]);
      homePolicy.default.invokeRolesPolicies();
      tasksPolicy.default.invokeRolesPolicies();
      uploadsPolicy.default.invokeRolesPolicies();
      usersAccountPolicy.default.invokeRolesPolicies();
      usersAdminPolicy.default.invokeRolesPolicies();
    });

    it('guest can read public task routes', async () => {
      const ability = await policy.defineAbilityFor(null);
      expect(ability.can('read', '/api/tasks')).toBe(true);
    });

    it('guest cannot create tasks', async () => {
      const ability = await policy.defineAbilityFor(null);
      expect(ability.can('create', '/api/tasks')).toBe(false);
    });

    it('user can manage tasks', async () => {
      const ability = await policy.defineAbilityFor({ roles: ['user'] });
      expect(ability.can('create', '/api/tasks')).toBe(true);
    });

    it('user cannot access admin routes', async () => {
      const ability = await policy.defineAbilityFor({ roles: ['user'] });
      expect(ability.can('read', '/api/users')).toBe(false);
    });

    it('admin can access admin routes', async () => {
      const ability = await policy.defineAbilityFor({ roles: ['admin'] });
      expect(ability.can('read', '/api/users')).toBe(true);
    });

    it('isAllowed should call next() for HEAD on an allowed route', async () => {
      const mockReq = { method: 'HEAD', route: { path: '/api/tasks' }, user: { roles: ['user'] } };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const mockNext = jest.fn();
      await policy.isAllowed(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('isAllowed should call next() for OPTIONS on an allowed route', async () => {
      const mockReq = { method: 'OPTIONS', route: { path: '/api/tasks' }, user: { roles: ['user'] } };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const mockNext = jest.fn();
      await policy.isAllowed(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('isAllowed should deny unknown HTTP methods with 405', async () => {
      const mockReq = { method: 'PROPFIND', route: { path: '/api/tasks' }, user: { roles: ['admin'] } };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const mockNext = jest.fn();
      await policy.isAllowed(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(405);
      const errorBody = mockRes.json.mock.calls[0][0];
      expect(errorBody).toEqual(
        expect.objectContaining({
          message: 'Method Not Allowed',
          description: 'HTTP method PROPFIND is not supported',
        }),
      );
    });
  });

  describe('Mongoose service', () => {
    it('should invoke callback after loading models', async () => {
      const callback = jest.fn();
      await mongooseService.loadModels(callback);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('Auth service', () => {
    let AuthService;

    beforeAll(async () => {
      AuthService = (await import(path.resolve('./modules/auth/services/auth.service.js'))).default;
    });

    it('should return null when removeSensitive is called with a non-object', () => {
      expect(AuthService.removeSensitive(null)).toBeNull();
      expect(AuthService.removeSensitive('string')).toBeNull();
      expect(AuthService.removeSensitive(undefined)).toBeNull();
    });

    it('should return picked fields when removeSensitive is called with a valid user', () => {
      const fakeUser = { id: '1', email: 'a@b.com', password: 'secret', firstName: 'A' };
      const result = AuthService.removeSensitive(fakeUser);
      expect(result).toBeDefined();
      expect(result.password).toBeUndefined();
    });

    it('should throw when checkPassword is called with a weak password', () => {
      expect(() => AuthService.checkPassword('password')).toThrow();
    });

    it('should return the password when checkPassword is called with a strong password', () => {
      const strong = 'C0rr3ct!H0rs3B@tt3ry';
      expect(AuthService.checkPassword(strong)).toBe(strong);
    });
  });
});
