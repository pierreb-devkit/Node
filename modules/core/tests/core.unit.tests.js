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
import errors from '../../../lib/helpers/errors.js';

import { bootstrap } from '../../../lib/app.js';

/**
 * Unit tests
 */
describe('Core unit tests:', () => {
  beforeAll(async () => {
    try {
      await bootstrap();
    } catch (err) {
      console.log(err);
    }
  });

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
      // mock();
    });

    afterEach(() => {
      config.log = originalLogConfig;
      // mock.restore();
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
      // manually set the config stream fileName option to an empty string
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
    });

    it('should not create a file transport object if critical options are missing: directory', () => {
      // manually set the config stream fileName option to an empty string
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
        expect(fromEmpty).toBe('error while retrieving the error :o : {}.');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });
  });

  // Mongoose disconnect
  afterAll(() =>
    mongooseService.disconnect().catch((e) => {
      console.log(e);
    }),
  );
});
