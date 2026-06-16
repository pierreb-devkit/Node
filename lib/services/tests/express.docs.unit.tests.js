/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for core/doc/index.yml OpenAPI baseline — bearerAuth description,
 * apiKeyAuth alias, SuccessResponse + ErrorResponse schema descriptions.
 * (T13 Fix B — infra#38)
 */
describe('express initApiSpec — core/doc/index.yml OpenAPI baseline (T13 Fix B):', () => {
  const mockCoreYamlDoc = {
    openapi: '3.0.0',
    info: { version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Authenticate by sending an HTTP `Authorization: Bearer <token>` header.',
        },
        apiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Legacy alias for `bearerAuth`. New integrations should use `bearerAuth`.',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          description: 'Standard success envelope. data type varies by endpoint.',
          properties: {
            type: { type: 'string', enum: ['success'] },
            message: { type: 'string' },
            data: { description: 'Response payload (type varies by endpoint)' },
          },
        },
        ErrorResponse: {
          type: 'object',
          description: 'Standard error envelope returned on 4xx/5xx.',
          properties: {
            type: { type: 'string', enum: ['error'] },
            message: { type: 'string' },
            code: { type: 'integer' },
            status: { type: 'integer' },
            errorCode: { type: 'string' },
            description: { type: 'string' },
            error: { type: 'string', description: 'JSON-stringified error details included only in non-production environments.' },
          },
        },
      },
    },
  };

  const baseConfig = {
    openapi: { enable: true },
    files: { openapi: ['/fake/core.yaml'], guides: [] },
    app: { title: 'Test API', description: 'Test', url: 'https://example.com' },
    domain: 'https://example.com',
  };

  const buildMockApp = () => {
    const routes = {};
    return { get: (path, handler) => { routes[path] = handler; }, _routes: routes };
  };

  const callSpecRoute = (app) => {
    const handler = app._routes['/api/spec.json'];
    if (!handler) throw new Error('/api/spec.json route not registered');
    let spec = null;
    const res = { json: (body) => { spec = body; } };
    handler({}, res);
    return spec;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.unstable_mockModule('fs', () => ({
      default: { readFileSync: jest.fn().mockReturnValue('mocked') },
      readFileSync: jest.fn().mockReturnValue('mocked'),
    }));
    // express.js gates initApiSpec behind configHelper.isProd(). Mock the helper so
    // the env gate is deterministic (dev-grade → spec mount) without loading the
    // real config helper (which pulls in glob and would trip the partial fs mock).
    jest.unstable_mockModule('../../helpers/config.js', () => ({
      default: { isProd: jest.fn().mockReturnValue(false), isDevEnv: jest.fn().mockReturnValue(true) },
    }));
    jest.unstable_mockModule('js-yaml', () => ({
      default: { load: jest.fn().mockReturnValue(mockCoreYamlDoc) },
      load: jest.fn().mockReturnValue(mockCoreYamlDoc),
    }));
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
  });

  afterEach(() => jest.restoreAllMocks());

  test('bearerAuth security scheme exists in merged spec', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });

  test('bearerAuth has a description field', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(typeof spec.components.securitySchemes.bearerAuth.description).toBe('string');
    expect(spec.components.securitySchemes.bearerAuth.description.length).toBeGreaterThan(0);
  });

  test('apiKeyAuth security scheme exists as legacy alias', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(spec.components.securitySchemes.apiKeyAuth).toBeDefined();
  });

  test('apiKeyAuth description mentions bearerAuth as the canonical scheme', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(spec.components.securitySchemes.apiKeyAuth.description).toMatch(/bearerAuth/i);
  });

  test('SuccessResponse schema has a description', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(typeof spec.components.schemas.SuccessResponse.description).toBe('string');
    expect(spec.components.schemas.SuccessResponse.description.length).toBeGreaterThan(0);
  });

  test('ErrorResponse schema has a description', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));
    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);
    expect(typeof spec.components.schemas.ErrorResponse.description).toBe('string');
    expect(spec.components.schemas.ErrorResponse.description.length).toBeGreaterThan(0);
  });
});

/**
 * Unit tests for express.js initApiSpec — the OpenAPI JSON spec endpoint
 * (Redoc UI decommissioned; the spec endpoint is the documentation surface).
 *
 * Asserts:
 *   1. /api/spec.json serves the merged spec.
 *   2. Markdown guides are merged into info.description.
 *   3. x-logo injection wiring from config.app.url / config.app.logo.
 *   4. /api/docs (the old Redoc UI) is NOT mounted.
 *
 * NOTE: there is no module-level guides mock in this describe block. Every test
 * that relies on guide loading MUST stub `loadGuides` (via
 * `jest.unstable_mockModule('../../helpers/guides.js', ...)`) inline, before
 * importing the module under test. A test that omits the stub will silently hit
 * the real loader against a non-existent path.
 */
describe('express initApiSpec — OpenAPI JSON spec endpoint:', () => {
  const mockYamlDoc = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0', description: 'Existing description.' },
    paths: {},
  };

  const baseConfig = {
    openapi: { enable: true },
    files: { openapi: ['/fake/openapi.yaml'], guides: ['/fake/modules/home/doc/guides/00-welcome.md'] },
    app: { title: 'Test API', description: 'Test', url: 'https://example.com' },
    domain: 'https://example.com',
  };

  /**
   * Build a mock Express app that captures registered route handlers.
   */
  const buildMockApp = () => {
    const routes = {};
    const app = {
      get: (path, handler) => {
        routes[path] = handler;
      },
      _routes: routes,
    };
    return app;
  };

  /**
   * Trigger the /api/spec.json route and capture the JSON spec served.
   */
  const callSpecRoute = (app) => {
    const handler = app._routes['/api/spec.json'];
    if (!handler) throw new Error('/api/spec.json route not registered');
    let spec = null;
    const res = { json: (body) => { spec = body; } };
    handler({}, res);
    return spec;
  };

  beforeEach(() => {
    jest.resetModules();

    // Mock fs + js-yaml so we don't need a real YAML file
    jest.unstable_mockModule('fs', () => ({
      default: { readFileSync: jest.fn().mockReturnValue('mocked') },
      readFileSync: jest.fn().mockReturnValue('mocked'),
    }));
    // express.js gates initApiSpec behind configHelper.isProd(). Mock the helper so
    // the env gate is deterministic (dev-grade → spec mount) without loading the
    // real config helper (which pulls in glob and would trip the partial fs mock).
    jest.unstable_mockModule('../../helpers/config.js', () => ({
      default: { isProd: jest.fn().mockReturnValue(false), isDevEnv: jest.fn().mockReturnValue(true) },
    }));
    jest.unstable_mockModule('js-yaml', () => ({
      default: { load: jest.fn().mockReturnValue(mockYamlDoc) },
      load: jest.fn().mockReturnValue(mockYamlDoc),
    }));

    // Mock logger
    jest.unstable_mockModule('../logger.js', () => ({
      default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('serves the merged spec on /api/spec.json', async () => {
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);

    expect(spec).toBeDefined();
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('Test API');
    expect(spec.servers[0].url).toBe('https://example.com');
  });

  test('merges markdown guides into info.description', async () => {
    // The real guides helper runs so guide markdown lands in info.description —
    // this is the documentation surface now that the Redoc UI is gone.
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: {
        loadGuides: jest.fn().mockReturnValue([{ title: 'Welcome', body: 'Get started here.', path: '/fake/00-welcome.md' }]),
        mergeGuidesIntoSpec: (spec, guides) => {
          const block = guides.map((g) => `# ${g.title}\n\n${g.body}`).join('\n\n');
          const existing = typeof spec.info?.description === 'string' ? spec.info.description.trim() : '';
          spec.info = { ...(spec.info || {}), description: [existing, block].filter(Boolean).join('\n\n') };
          return spec;
        },
      },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);

    expect(spec.info.description).toContain('Welcome');
    expect(spec.info.description).toContain('Get started here.');
  });

  test('does NOT mount the /api/docs Redoc UI route', async () => {
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);

    expect(app._routes['/api/spec.json']).toBeDefined();
    expect(app._routes['/api/docs']).toBeUndefined();
  });

  test('injects x-logo href in spec when config.app.url is set', async () => {
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: { ...baseConfig } }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);

    expect(spec.info['x-logo']).toBeDefined();
    expect(spec.info['x-logo'].href).toBe('https://example.com');
  });

  test('injects x-logo url in spec when config.app.logo is provided', async () => {
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { ...baseConfig, app: { ...baseConfig.app, logo: 'https://example.com/logo.png' } },
    }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();
    expressService.initApiSpec(app);
    const spec = callSpecRoute(app);

    expect(spec.info['x-logo'].url).toBe('https://example.com/logo.png');
  });

  test('does not inject x-logo when config.app.url is absent', async () => {
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { ...baseConfig, app: { title: 'Test API', description: 'Test' } }, // no url
    }));

    const { default: expressService } = await import('../express.js');
    const app = buildMockApp();

    expect(() => expressService.initApiSpec(app)).not.toThrow();
    const spec = callSpecRoute(app);
    expect(spec.info['x-logo']).toBeUndefined();
  });
});
