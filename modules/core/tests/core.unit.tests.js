/**
 * Module dependencies.
 */
import _ from 'lodash';
import path from 'path';
import { jest } from '@jest/globals';

import assets from '../../../config/assets.js';
import config, { deepMerge, assertSafeEnv } from '../../../config/index.js';
import configHelper from '../../../lib/helpers/config.js';
import guidesHelper from '../../../lib/helpers/guides.js';
import logger from '../../../lib/services/logger.js';
import mongooseService from '../../../lib/services/mongoose.js';
import expressService from '../../../lib/services/express.js';
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import AppError from '../../../lib/helpers/AppError.js';
import policy from '../../../lib/middlewares/policy.js';
import multerService from '../../../lib/services/multer.js';

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
      const expectedKeys = ['allJS', 'allYaml', 'allGuides', 'mongooseModels', 'preRoutes', 'routes', 'config', 'policies'];

      expectedKeys.forEach((key) => {
        expect(assets).toHaveProperty(key);
      });
    });

    it('config should load production configuration in production env', async () => {
      try {
        const defaultConfig = (await import(path.join(process.cwd(), './config', 'defaults', 'production.config.js'))) || {};
        expect(defaultConfig.default.app.title.split(' - ')[1]).toBe('Production Environment');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    it('deepMerge should give per-module project config higher priority than global project config', () => {
      // Module configs export a flat shape (e.g. { whitelists: { users: { roles: [...] } } })
      const globalProject = { whitelists: { users: { roles: ['user'] } } };
      const moduleProject = { whitelists: { users: { roles: ['user', 'admin', 'custom'] } } };
      const merged = deepMerge(globalProject, moduleProject);
      expect(merged.whitelists.users.roles).toEqual(['user', 'admin', 'custom']);
    });

    it('assertSafeEnv should allow valid environment names', () => {
      expect(() => assertSafeEnv('development')).not.toThrow();
      expect(() => assertSafeEnv('production')).not.toThrow();
      expect(() => assertSafeEnv('trawl')).not.toThrow();
      expect(() => assertSafeEnv('my-project_v2')).not.toThrow();
    });

    it('assertSafeEnv should reject env names with glob metacharacters or path separators', () => {
      expect(() => assertSafeEnv('bad*env')).toThrow();
      expect(() => assertSafeEnv('../etc/passwd')).toThrow();
      expect(() => assertSafeEnv('env/name')).toThrow();
      expect(() => assertSafeEnv('env\\name')).toThrow();
      expect(() => assertSafeEnv('env name')).toThrow();
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
      expect(userAvatarConfig.limits.fileSize).toBe(52428);
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

  describe('Multer fileFilter', () => {
    it('should reject files exceeding size limit with SERVICE_ERROR code', () => {
      const filter = multerService.fileFilter(['image/png'], 1024);
      const req = { headers: { 'content-length': '2048' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
      const err = cb.mock.calls[0][0];
      expect(err.code).toBe('SERVICE_ERROR');
    });

    it('should reject files with unsupported mimetype with SERVICE_ERROR code', () => {
      const filter = multerService.fileFilter(['image/png'], 10240);
      const req = { headers: { 'content-length': '512' } };
      const file = { mimetype: 'application/pdf' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
      const err = cb.mock.calls[0][0];
      expect(err.code).toBe('SERVICE_ERROR');
    });

    it('should accept files within size limit and matching mimetype', () => {
      const filter = multerService.fileFilter(['image/png'], 10240);
      const req = { headers: { 'content-length': '512' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('should not call cb multiple times when file is too large', () => {
      const filter = multerService.fileFilter(['image/png'], 1024);
      const req = { headers: { 'content-length': '2048' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('Express service', () => {
    describe('initSwagger', () => {
      let originalSwagger;
      let originalFiles;

      beforeEach(() => {
        originalSwagger = config.swagger;
        originalFiles = config.files;
      });

      afterEach(() => {
        config.swagger = originalSwagger;
        config.files = originalFiles;
      });

      it('should register /api/spec.json and /api/docs when swagger is enabled', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')] };
        const mockGet = jest.fn();
        const mockUse = jest.fn();
        const mockApp = { get: mockGet, use: mockUse };
        expressService.initSwagger(mockApp);
        expect(mockGet).toHaveBeenCalledWith('/api/spec.json', expect.any(Function));
        expect(mockUse).toHaveBeenCalledWith('/api/docs', expect.any(Function));
      });

      it('should serve merged spec as JSON from /api/spec.json handler', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')] };
        const mockGet = jest.fn();
        const mockUse = jest.fn();
        const mockApp = { get: mockGet, use: mockUse };
        expressService.initSwagger(mockApp);
        // Extract the handler registered for /api/spec.json
        const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
        const mockRes = { json: jest.fn() };
        handler({}, mockRes);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({ openapi: '3.0.0' }),
        );
      });

      it('should merge multiple module YAML files and include paths from each', () => {
        config.swagger = { enable: true };
        config.files = {
          ...config.files,
          swagger: [
            path.join(process.cwd(), 'modules/core/doc/index.yml'),
            path.join(process.cwd(), 'modules/tasks/doc/tasks.yml'),
          ],
        };
        const mockGet = jest.fn();
        const mockUse = jest.fn();
        const mockApp = { get: mockGet, use: mockUse };
        expressService.initSwagger(mockApp);
        const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
        const mockRes = { json: jest.fn() };
        handler({}, mockRes);
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            openapi: '3.0.0',
            paths: expect.objectContaining({
              '/api/tasks': expect.any(Object),
            }),
            components: expect.objectContaining({
              schemas: expect.objectContaining({
                Task: expect.any(Object),
              }),
            }),
          }),
        );
      });

      it('should not register routes when swagger is disabled', () => {
        config.swagger = { enable: false };
        const mockGet = jest.fn();
        const mockUse = jest.fn();
        const mockApp = { get: mockGet, use: mockUse };
        expressService.initSwagger(mockApp);
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockUse).not.toHaveBeenCalled();
      });

      it('should warn and skip registration when swagger file list is empty', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: [] };
        const mockGet = jest.fn();
        const mockUse = jest.fn();
        const mockApp = { get: mockGet, use: mockUse };
        expressService.initSwagger(mockApp);
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockUse).not.toHaveBeenCalled();
      });

      it('should throw with file path context when a YAML file fails to load', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: ['/nonexistent/path/bad.yml'] };
        const mockApp = { get: jest.fn(), use: jest.fn() };
        expect(() => expressService.initSwagger(mockApp)).toThrow('[swagger] failed to load /nonexistent/path/bad.yml');
      });

      it('should skip YAML files that do not parse to a plain object and still register routes from valid ones', async () => {
        // Write a temp YAML file that parses to a scalar string (not an object) — triggers the non-object guard
        const { default: fsMod } = await import('fs');
        const tmpFile = path.join('/tmp', `test-scalar-${Date.now()}.yml`);
        fsMod.writeFileSync(tmpFile, 'just a string value\n');
        try {
          const validFile = path.join(process.cwd(), 'modules/core/doc/index.yml');
          config.swagger = { enable: true };
          config.files = { ...config.files, swagger: [tmpFile, validFile] };
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          expect(mockGet).toHaveBeenCalledWith('/api/spec.json', expect.any(Function));
        } finally {
          fsMod.unlinkSync(tmpFile);
        }
      });

      it('should merge markdown guides into spec info.description when guides are configured', async () => {
        const { default: fsMod } = await import('fs');
        const tmpDir = path.join('/tmp', `guides-${Date.now()}`);
        fsMod.mkdirSync(tmpDir, { recursive: true });
        const tmpGuide = path.join(tmpDir, 'sample.md');
        fsMod.writeFileSync(tmpGuide, '# Ignored Heading\n\nSample guide body for unit test.\n');
        try {
          config.swagger = { enable: true };
          config.files = {
            ...config.files,
            swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')],
            guides: [tmpGuide],
          };
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
          const mockRes = { json: jest.fn() };
          handler({}, mockRes);
          const served = mockRes.json.mock.calls[0][0];
          expect(served.info).toBeDefined();
          expect(typeof served.info.description).toBe('string');
          // Guide loader derives the H1 from the file basename, not the markdown H1.
          expect(served.info.description).toContain('# Sample');
          expect(served.info.description).toContain('Sample guide body for unit test.');
        } finally {
          fsMod.unlinkSync(tmpGuide);
          fsMod.rmdirSync(tmpDir);
        }
      });

      it('should inject info.title, info.description and servers from config', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')], guides: [] };
        const originalDomain = config.domain;
        config.domain = 'https://api.example.test';
        try {
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
          const mockRes = { json: jest.fn() };
          handler({}, mockRes);
          const served = mockRes.json.mock.calls[0][0];
          expect(served.info.title).toBe(config.app.title);
          expect(served.info.description).toBe(config.app.description);
          expect(served.servers).toEqual([{ url: 'https://api.example.test' }]);
        } finally {
          config.domain = originalDomain;
        }
      });

      it('should fall back to localhost in servers when config.domain is empty', () => {
        config.swagger = { enable: true };
        config.files = { ...config.files, swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')], guides: [] };
        const originalDomain = config.domain;
        config.domain = '';
        try {
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
          const mockRes = { json: jest.fn() };
          handler({}, mockRes);
          const served = mockRes.json.mock.calls[0][0];
          expect(served.servers).toEqual([{ url: 'http://localhost:3000' }]);
        } finally {
          config.domain = originalDomain;
        }
      });

      it('should preserve config description then append guides on top', async () => {
        const { default: fsMod } = await import('fs');
        const tmpDir = path.join('/tmp', `guides-inject-${Date.now()}`);
        fsMod.mkdirSync(tmpDir, { recursive: true });
        const tmpGuide = path.join(tmpDir, 'welcome.md');
        fsMod.writeFileSync(tmpGuide, 'Welcome guide content for description merge.\n');
        try {
          config.swagger = { enable: true };
          config.files = {
            ...config.files,
            swagger: [path.join(process.cwd(), 'modules/core/doc/index.yml')],
            guides: [tmpGuide],
          };
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          const handler = mockGet.mock.calls.find((c) => c[0] === '/api/spec.json')[1];
          const mockRes = { json: jest.fn() };
          handler({}, mockRes);
          const served = mockRes.json.mock.calls[0][0];
          // Config description must be first, guide content appended after
          expect(served.info.description.startsWith(config.app.description)).toBe(true);
          expect(served.info.description).toContain('Welcome guide content for description merge.');
        } finally {
          fsMod.unlinkSync(tmpGuide);
          fsMod.rmdirSync(tmpDir);
        }
      });

      it('should warn and skip registration when all YAML files produce an empty spec', async () => {
        // Write a temp YAML file that parses to a scalar — after filter(Boolean), contents is empty → spec is {}
        const { default: fsMod } = await import('fs');
        const tmpFile = path.join('/tmp', `test-scalar-only-${Date.now()}.yml`);
        fsMod.writeFileSync(tmpFile, 'just a string value\n');
        try {
          config.swagger = { enable: true };
          config.files = { ...config.files, swagger: [tmpFile] };
          const mockGet = jest.fn();
          const mockUse = jest.fn();
          const mockApp = { get: mockGet, use: mockUse };
          expressService.initSwagger(mockApp);
          expect(mockGet).not.toHaveBeenCalled();
          expect(mockUse).not.toHaveBeenCalled();
        } finally {
          fsMod.unlinkSync(tmpFile);
        }
      });
    });

    describe('trust proxy', () => {
      let originalTrust;

      beforeEach(() => {
        originalTrust = config.trust;
      });

      afterEach(() => {
        config.trust = originalTrust;
      });

      it('should set trust proxy when config.trust.proxy is true', () => {
        config.trust = { proxy: true };
        const mockApp = { locals: {}, use: jest.fn(), set: jest.fn() };
        expressService.initMiddleware(mockApp);
        expect(mockApp.set).toHaveBeenCalledWith('trust proxy', true);
      });

      it('should not set trust proxy when config.trust.proxy is false', () => {
        config.trust = { proxy: false };
        const mockApp = { locals: {}, use: jest.fn(), set: jest.fn() };
        expressService.initMiddleware(mockApp);
        expect(mockApp.set).not.toHaveBeenCalledWith('trust proxy', true);
      });

      it('should not set trust proxy when config.trust is undefined', () => {
        delete config.trust;
        const mockApp = { locals: {}, use: jest.fn(), set: jest.fn() };
        expressService.initMiddleware(mockApp);
        expect(mockApp.set).not.toHaveBeenCalledWith('trust proxy', true);
      });
    });

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

  describe('Guides helper', () => {
    it('should derive a title-cased title from a guide file path', () => {
      expect(guidesHelper.titleFromPath('modules/example/doc/guides/getting-started.md')).toBe('Getting Started');
      expect(guidesHelper.titleFromPath('/abs/path/api-reference.md')).toBe('Api Reference');
      expect(guidesHelper.titleFromPath('multi_word_file.md')).toBe('Multi Word File');
    });

    it('should strip a leading numeric ordering prefix before title-casing', () => {
      expect(guidesHelper.titleFromPath('00-welcome.md')).toBe('Welcome');
      expect(guidesHelper.titleFromPath('01-api-access.md')).toBe('Api Access');
      expect(guidesHelper.titleFromPath('/abs/path/10-getting-started.md')).toBe('Getting Started');
      expect(guidesHelper.titleFromPath('007_secret_agent.md')).toBe('Secret Agent');
    });

    it('should keep titles without a numeric prefix unchanged', () => {
      expect(guidesHelper.titleFromPath('welcome.md')).toBe('Welcome');
      expect(guidesHelper.titleFromPath('getting-started.md')).toBe('Getting Started');
    });

    it('should fall back to the raw basename for digits-only filenames', () => {
      expect(guidesHelper.titleFromPath('42.md')).toBe('42');
      expect(guidesHelper.titleFromPath('/abs/path/007.md')).toBe('007');
    });

    it('should load guides and sort by filename so numeric prefixes control order', async () => {
      const { default: fsMod } = await import('fs');
      const tmpDir = path.join('/tmp', `guides-order-${Date.now()}`);
      fsMod.mkdirSync(tmpDir, { recursive: true });
      const files = [
        { name: '02-scraping.md', body: '# Scraping\n\nScraping body.\n' },
        { name: '00-welcome.md', body: '# Welcome\n\nWelcome body.\n' },
        { name: '01-api-access.md', body: '# Api Access\n\nAccess body.\n' },
      ].map(({ name, body }) => {
        const full = path.join(tmpDir, name);
        fsMod.writeFileSync(full, body);
        return full;
      });
      try {
        const guides = guidesHelper.loadGuides(files);
        expect(guides.map((g) => g.title)).toEqual(['Welcome', 'Api Access', 'Scraping']);
      } finally {
        files.forEach((f) => fsMod.unlinkSync(f));
        fsMod.rmdirSync(tmpDir);
      }
    });

    it('should strip the leading H1 from markdown content', () => {
      const input = '# Title\n\nBody paragraph';
      expect(guidesHelper.stripLeadingH1(input)).toBe('Body paragraph');
    });

    it('should preserve markdown when no leading H1 is present', () => {
      const input = 'Body paragraph\n\n## Subsection';
      expect(guidesHelper.stripLeadingH1(input)).toBe('Body paragraph\n\n## Subsection');
    });

    it('should load guides from real files and sort them alphabetically', async () => {
      const { default: fsMod } = await import('fs');
      const tmpDir = path.join('/tmp', `guides-fixture-${Date.now()}`);
      fsMod.mkdirSync(tmpDir, { recursive: true });
      const files = [
        { name: 'organizations.md', body: '# Organizations\n\nOrg body.\n' },
        { name: 'authentication.md', body: '# Authentication\n\nAuth body.\n' },
        { name: 'getting-started.md', body: '# Getting Started\n\nIntro body.\n' },
      ].map(({ name, body }) => {
        const full = path.join(tmpDir, name);
        fsMod.writeFileSync(full, body);
        return full;
      });
      try {
        const guides = guidesHelper.loadGuides(files);
        expect(guides.map((g) => g.title)).toEqual(['Authentication', 'Getting Started', 'Organizations']);
        guides.forEach((g) => expect(typeof g.body).toBe('string'));
      } finally {
        files.forEach((f) => fsMod.unlinkSync(f));
        fsMod.rmdirSync(tmpDir);
      }
    });

    it('should return an empty array when filePaths is empty or invalid', () => {
      expect(guidesHelper.loadGuides([])).toEqual([]);
      expect(guidesHelper.loadGuides(null)).toEqual([]);
      expect(guidesHelper.loadGuides(undefined)).toEqual([]);
    });

    it('should skip unreadable guide files without throwing', () => {
      const guides = guidesHelper.loadGuides(['/nonexistent/path/missing.md']);
      expect(guides).toEqual([]);
    });

    it('should skip guides whose body is empty after stripping the H1', async () => {
      const { default: fsMod } = await import('fs');
      const tmpFile = path.join('/tmp', `test-empty-guide-${Date.now()}.md`);
      fsMod.writeFileSync(tmpFile, '# Only a title\n');
      try {
        expect(guidesHelper.loadGuides([tmpFile])).toEqual([]);
      } finally {
        fsMod.unlinkSync(tmpFile);
      }
    });

    it('should merge guides into spec info.description with H1 section headers', () => {
      const spec = { openapi: '3.0.0', info: { title: 'API' } };
      const guides = [
        { title: 'Getting Started', body: 'Intro body' },
        { title: 'Authentication', body: 'Auth body' },
      ];
      guidesHelper.mergeGuidesIntoSpec(spec, guides);
      expect(spec.info.description).toContain('# Getting Started');
      expect(spec.info.description).toContain('Intro body');
      expect(spec.info.description).toContain('# Authentication');
      expect(spec.info.description).toContain('Auth body');
    });

    it('should preserve an existing info.description when merging guides', () => {
      const spec = { info: { description: 'Original intro.' } };
      guidesHelper.mergeGuidesIntoSpec(spec, [{ title: 'Guide', body: 'Body' }]);
      expect(spec.info.description.startsWith('Original intro.')).toBe(true);
      expect(spec.info.description).toContain('# Guide');
    });

    it('should be a no-op when no guides are provided', () => {
      const spec = { info: { title: 'API' } };
      const result = guidesHelper.mergeGuidesIntoSpec(spec, []);
      expect(result).toBe(spec);
      expect(spec.info.description).toBeUndefined();
    });

    it('should return the spec unchanged when spec is not an object', () => {
      expect(guidesHelper.mergeGuidesIntoSpec(null, [{ title: 't', body: 'b' }])).toBeNull();
    });
  });

  describe('Policy', () => {
    beforeAll(async () => {
      // Auto-discover and register all policy files using the new abilities pattern
      const policyPaths = await configHelper.getGlobbedPaths(assets.policies);
      await policy.discoverPolicies(policyPaths);
    });

    it('guest cannot read tasks (org-scoped, JWT required)', async () => {
      const ability = await policy.defineAbilityFor(null);
      expect(ability.can('read', 'Task')).toBe(false);
    });

    it('guest cannot create tasks', async () => {
      const ability = await policy.defineAbilityFor(null);
      expect(ability.can('create', 'Task')).toBe(false);
    });

    it('user can create tasks', async () => {
      const membership = { organizationId: 'org1' };
      const ability = await policy.defineAbilityFor({ _id: 'user1', roles: ['user'] }, membership);
      expect(ability.can('create', 'Task')).toBe(true);
    });

    it('user cannot access admin user routes', async () => {
      const ability = await policy.defineAbilityFor({ _id: 'user1', roles: ['user'] });
      expect(ability.can('read', 'UserAdmin')).toBe(false);
    });

    it('admin can access admin user routes', async () => {
      const ability = await policy.defineAbilityFor({ _id: 'admin1', roles: ['admin'] });
      expect(ability.can('read', 'UserAdmin')).toBe(true);
    });

    it('isAllowed should call next() for HEAD on an allowed route', async () => {
      const mockReq = { method: 'HEAD', route: { path: '/api/users/me' }, user: { _id: 'user1', roles: ['user'] } };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const mockNext = jest.fn();
      await policy.isAllowed(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('isAllowed should call next() for OPTIONS on an allowed route', async () => {
      const mockReq = { method: 'OPTIONS', route: { path: '/api/users/me' }, user: { _id: 'user1', roles: ['user'] } };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const mockNext = jest.fn();
      await policy.isAllowed(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('isAllowed should deny unknown HTTP methods with 405', async () => {
      const mockReq = { method: 'PROPFIND', route: { path: '/api/tasks' }, user: { _id: 'admin1', roles: ['admin'] } };
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

  describe('deepMerge', () => {
    it('should replace arrays instead of merging by index', () => {
      const target = { items: ['a', 'b', 'c', 'd'] };
      const source = { items: ['x', 'y'] };
      const result = deepMerge(target, source);
      expect(result.items).toEqual(['x', 'y']);
    });

    it('should deep merge nested objects', () => {
      const target = { a: { b: 1, c: 2 } };
      const source = { a: { c: 3, d: 4 } };
      const result = deepMerge(target, source);
      expect(result.a).toEqual({ b: 1, c: 3, d: 4 });
    });

    it('should skip undefined values', () => {
      const target = { a: 1, b: 2 };
      const source = { a: undefined, b: 3 };
      const result = deepMerge(target, source);
      expect(result.a).toBe(1);
      expect(result.b).toBe(3);
    });

    it('should skip unsafe keys', () => {
      const target = { safe: 1 };
      const source = { safe: 2 };
      Object.defineProperty(source, '__proto__', { value: { polluted: true }, enumerable: true });
      const result = deepMerge(target, source);
      expect(result.polluted).toBeUndefined();
      expect(result.safe).toBe(2);
    });

    it('should not mutate source arrays', () => {
      const sourceArr = ['a', 'b'];
      const result = deepMerge({ items: ['x'] }, { items: sourceArr });
      result.items.push('c');
      expect(sourceArr).toEqual(['a', 'b']);
    });
  });
});
