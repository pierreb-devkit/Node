/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — initSwagger must be secure-by-default: API docs (/api/spec.json +
 * /api/docs) are mounted ONLY in dev-grade envs (development/test/local). Under any
 * production-grade env (the literal `production` OR a deployment env label), the
 * unauthenticated docs surface must NOT be mounted, even if config.swagger.enable
 * is still truthy. This closes the env-gate defect where docs were exposed
 * downstream because the gate keyed off the literal `production`.
 */
describe('express initSwagger — env gate (docs off in non-dev envs):', () => {
  let originalNodeEnv;

  const mockYamlDoc = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0', description: 'Test' },
    paths: {},
  };

  const baseConfig = {
    swagger: { enable: true },
    files: { swagger: ['/fake/swagger.yaml'], guides: [] },
    app: { title: 'Test API', description: 'Test', url: 'https://example.com' },
    domain: 'https://example.com',
  };

  /**
   * Build a minimal mock Express app that records registered GET routes.
   * @returns {{ get: Function, _routes: Object<string, Function> }} mock app
   */
  const buildMockApp = () => {
    const routes = {};
    return { get: (path, handler) => { routes[path] = handler; }, _routes: routes };
  };

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    jest.resetModules();
    jest.unstable_mockModule('fs', () => ({
      default: { readFileSync: jest.fn().mockReturnValue('mocked') },
      readFileSync: jest.fn().mockReturnValue('mocked'),
    }));
    jest.unstable_mockModule('js-yaml', () => ({
      default: { load: jest.fn().mockReturnValue(mockYamlDoc) },
      load: jest.fn().mockReturnValue(mockYamlDoc),
    }));
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
    // Mock the config helper with a faithful env predicate reading NODE_ENV at call
    // time — this exercises the real gate semantics (dev allow-list) while avoiding
    // loading the real helper (which pulls in glob and trips the partial fs mock).
    // NOTE: this set MUST stay in sync with DEV_ENVS in lib/helpers/config.js.
    const DEV_ENVS = new Set(['development', 'test', 'local']);
    jest.unstable_mockModule('../../helpers/config.js', () => ({
      default: {
        isProd: (env = process.env.NODE_ENV ?? 'development') => !DEV_ENVS.has(env),
        isDevEnv: (env = process.env.NODE_ENV ?? 'development') => DEV_ENVS.has(env),
      },
    }));
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  /**
   * Run initSwagger under a given NODE_ENV with config.swagger.enable left truthy.
   * @param {string} env - NODE_ENV value to set before init
   * @returns {Promise<object>} the registered routes map
   */
  const initUnderEnv = async (env) => {
    process.env.NODE_ENV = env;
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initSwagger(app);
    return app._routes;
  };

  test('does NOT mount /api/spec.json or /api/docs under a project (non-dev) env', async () => {
    const routes = await initUnderEnv('someproject');
    expect(routes['/api/spec.json']).toBeUndefined();
    expect(routes['/api/docs']).toBeUndefined();
  });

  test('does NOT mount docs under the literal production env', async () => {
    const routes = await initUnderEnv('production');
    expect(routes['/api/spec.json']).toBeUndefined();
    expect(routes['/api/docs']).toBeUndefined();
  });

  test('DOES mount docs under development (config.swagger.enable === true)', async () => {
    const routes = await initUnderEnv('development');
    expect(typeof routes['/api/spec.json']).toBe('function');
    expect(typeof routes['/api/docs']).toBe('function');
  });

  test('DOES mount docs under test (dev-grade env)', async () => {
    const routes = await initUnderEnv('test');
    expect(typeof routes['/api/spec.json']).toBe('function');
    expect(typeof routes['/api/docs']).toBe('function');
  });

  test('DOES mount docs under local (dev-grade env)', async () => {
    const routes = await initUnderEnv('local');
    expect(typeof routes['/api/spec.json']).toBe('function');
    expect(typeof routes['/api/docs']).toBe('function');
  });

  test('does NOT mount docs in dev when config.swagger.enable is false', async () => {
    process.env.NODE_ENV = 'development';
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { ...baseConfig, swagger: { enable: false } },
    }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initSwagger(app);
    expect(app._routes['/api/spec.json']).toBeUndefined();
    expect(app._routes['/api/docs']).toBeUndefined();
  });
});
