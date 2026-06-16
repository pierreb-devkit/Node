import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for computeOpenApiServerUrl — pure function, no Express/config side-effects.
 * express.js has transitive deps (logger, config) so we mock all module-level deps
 * before importing to isolate the pure computation.
 */
describe('lib/services/express — OpenAPI servers.url derivation:', () => {
  beforeEach(() => jest.resetModules());

  const getComputeOpenApiServerUrl = async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        domain: 'http://localhost:3000',
        openapi: { enable: false },
        app: { title: 'test', description: 'd' },
        files: { openapi: [], guides: [], routes: [], configs: [], policies: [], preRoutes: [] },
        bodyParser: {},
        cors: { origin: [], credentials: false },
        csrf: {},
        posthog: {},
        analytics: {},
        trust: {},
        log: { fileLogger: { directoryPath: '/tmp', fileName: 'test.log' } },
      },
    }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        getLogFormat: jest.fn().mockReturnValue('dev'),
        getMorganOptions: jest.fn().mockReturnValue({}),
      },
    }));
    jest.unstable_mockModule('../../../lib/services/errorTracker.js', () => ({
      default: { setupExpressErrorHandler: jest.fn(), init: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { init: jest.fn().mockResolvedValue(undefined), isConfigured: jest.fn().mockReturnValue(false) },
    }));
    jest.unstable_mockModule('../../../lib/helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/requestId.js', () => ({ default: jest.fn() }));
    jest.unstable_mockModule('../../../lib/middlewares/analytics.js', () => ({ default: jest.fn() }));
    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { discoverPolicies: jest.fn().mockResolvedValue(undefined) },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/posthog-context.middleware.js', () => ({
      posthogContextMiddleware: jest.fn(),
    }));

    const mod = await import('../../../lib/services/express.js');
    return mod.computeOpenApiServerUrl;
  };

  test('keeps full URL when domain already has http:// scheme', async () => {
    const fn = await getComputeOpenApiServerUrl();
    expect(fn('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('keeps full URL when domain already has https:// scheme with custom subdomain', async () => {
    const fn = await getComputeOpenApiServerUrl();
    expect(fn('https://app.example.com')).toBe('https://app.example.com');
  });

  test('prepends https://api. when domain is a bare host (no scheme)', async () => {
    const fn = await getComputeOpenApiServerUrl();
    expect(fn('acme.dev')).toBe('https://api.acme.dev');
  });

  test('prepends https://api. for any bare host', async () => {
    const fn = await getComputeOpenApiServerUrl();
    expect(fn('example.com')).toBe('https://api.example.com');
  });

  test('falls back to http://localhost:3000 when domain is falsy', async () => {
    const fn = await getComputeOpenApiServerUrl();
    expect(fn('')).toBe('http://localhost:3000');
    expect(fn(null)).toBe('http://localhost:3000');
    expect(fn(undefined)).toBe('http://localhost:3000');
  });
});
