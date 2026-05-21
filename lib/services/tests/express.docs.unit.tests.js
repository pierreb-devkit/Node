/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for express.js initSwagger — Redoc theme polish (issue #3686).
 *
 * Two scenarios:
 *   1. Default theme markers (Inter + JetBrains Mono) appear in served HTML.
 *   2. config.docs.redocTheme deep-merge override (e.g. primary color) reaches served HTML.
 */
describe('express initSwagger — Redoc theme (issue #3686):', () => {
  let capturedHtml;

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
   * Build a mock Express app that captures responses for /api/docs and /api/spec.json
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
   * Trigger the /api/docs route and capture the HTML sent
   */
  const callDocsRoute = (app) => {
    const handler = app._routes['/api/docs'];
    if (!handler) throw new Error('/api/docs route not registered');
    let html = null;
    const res = {
      type: jest.fn(),
      send: (body) => {
        html = body;
      },
    };
    handler({}, res);
    return html;
  };

  /**
   * Trigger the /api/spec.json route and capture the JSON spec served
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
    capturedHtml = null;

    // Mock fs + js-yaml so we don't need a real YAML file
    jest.unstable_mockModule('fs', () => ({
      default: { readFileSync: jest.fn().mockReturnValue('mocked') },
      readFileSync: jest.fn().mockReturnValue('mocked'),
    }));
    jest.unstable_mockModule('js-yaml', () => ({
      default: { load: jest.fn().mockReturnValue(mockYamlDoc) },
      load: jest.fn().mockReturnValue(mockYamlDoc),
    }));

    // Mock guides helper — no guides
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: {
        loadGuides: jest.fn().mockReturnValue([]),
        mergeGuidesIntoSpec: jest.fn(),
      },
    }));

    // Mock logger
    jest.unstable_mockModule('../logger.js', () => ({
      default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('default theme (no config.docs override):', () => {
    test('should include Inter font family in serialised Redoc options', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: baseConfig,
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('Inter');
    });

    test('should include JetBrains Mono in serialised Redoc options', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: baseConfig,
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('JetBrains Mono');
    });

    test('should include tighter sidebar width (260px) in serialised Redoc options', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: baseConfig,
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('260px');
    });

    test('should include dark right panel background (#1a1a1a) in serialised Redoc options', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: baseConfig,
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('#1a1a1a');
    });

    test('should inject x-logo href in spec when config.app.url is set', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { ...baseConfig },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      const spec = callSpecRoute(app);

      // x-logo is added to spec.info when config.app.url is present
      expect(spec.info['x-logo']).toBeDefined();
      expect(spec.info['x-logo'].href).toBe('https://example.com');
    });

    test('should inject x-logo url in spec when config.app.logo is provided', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          app: { ...baseConfig.app, logo: 'https://example.com/logo.png' },
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      const spec = callSpecRoute(app);

      expect(spec.info['x-logo'].url).toBe('https://example.com/logo.png');
    });

    test('should not inject x-logo when config.app.url is absent', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          app: { title: 'Test API', description: 'Test' }, // no url
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();

      // Must not throw and no x-logo in spec
      expect(() => expressService.initSwagger(app)).not.toThrow();
      const spec = callSpecRoute(app);
      expect(spec.info['x-logo']).toBeUndefined();
    });
  });

  describe('config.docs.redocTheme deep-merge override:', () => {
    test('should apply custom primary color from config.docs.redocTheme override', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          docs: {
            redocTheme: {
              colors: { primary: { main: '#ff0000' } },
            },
          },
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      // Override color reaches the HTML
      expect(capturedHtml).toContain('#ff0000');
    });

    test('should preserve default font family when override adds a color', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          docs: {
            redocTheme: {
              colors: { primary: { main: '#00ff00' } },
            },
          },
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      // Default font must still be present even when an override is applied
      expect(capturedHtml).toContain('Inter');
      expect(capturedHtml).toContain('#00ff00');
    });

    test('should allow override to replace sidebar width', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          docs: {
            redocTheme: {
              sidebar: { width: '300px' },
            },
          },
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('300px');
    });

    test('should apply devkit defaults when config.docs is absent', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          ...baseConfig,
          // no docs key at all
        },
      }));

      const { default: expressService } = await import('../express.js');
      const app = buildMockApp();
      expressService.initSwagger(app);
      capturedHtml = callDocsRoute(app);

      expect(capturedHtml).toContain('Inter');
      expect(capturedHtml).toContain('JetBrains Mono');
    });
  });
});
