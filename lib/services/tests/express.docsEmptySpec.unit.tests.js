/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — initApiSpec must tolerate a content-free OpenAPI spec file.
 *
 * js-yaml v5 raises `expected a document, but the input is empty` for a document
 * with no content, where v4 returned `undefined`. Since config.files.openapi is
 * globbed from every module's doc directory, a downstream module that ships a
 * stubbed or fully commented-out spec would otherwise take the application down
 * at boot.
 *
 * These tests deliberately DO NOT mock js-yaml: a hand-written mock can only throw
 * for the inputs its author thought of, and the comment-only case was missed exactly
 * that way. Only the real parser can say what it actually rejects.
 */
describe('express initApiSpec — content-free spec files (real js-yaml):', () => {
  const baseConfig = {
    openapi: { enable: true },
    files: { openapi: ['/fake/openapi.yaml'], guides: [] },
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

  /**
   * Mock everything except js-yaml, then run initApiSpec over a single spec file
   * whose raw content is `raw`.
   * @param {string} raw - file content served by the mocked fs.readFileSync
   * @returns {Promise<{app: object, logger: object, run: Function}>} harness
   */
  const harnessFor = async (raw) => {
    jest.unstable_mockModule('fs', () => ({
      default: { readFileSync: jest.fn().mockReturnValue(raw) },
      readFileSync: jest.fn().mockReturnValue(raw),
    }));
    jest.unstable_mockModule('../../helpers/config.js', () => ({
      default: { isProd: jest.fn().mockReturnValue(false), isDevEnv: jest.fn().mockReturnValue(true) },
    }));
    jest.unstable_mockModule('../../helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../logger.js', () => ({
      default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: baseConfig }));

    const { default: expressService } = await import('../express.js');
    const { default: logger } = await import('../logger.js');
    const app = buildMockApp();
    return { app, logger, run: () => expressService.initApiSpec(app) };
  };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Every one of these makes real js-yaml v5 raise the empty-document error.
  test.each([
    ['zero-byte', ''],
    ['whitespace-only', '   \n\n  '],
    ['comment-only', '# TODO: document this module\n'],
    ['BOM-only', '\uFEFF'],
  ])('%s spec file is skipped with a warning, never a boot failure', async (_label, raw) => {
    const { app, logger, run } = await harnessFor(raw);

    expect(run).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping'));
    expect(app._routes['/api/spec.json']).toBeUndefined();
  });

  test('a genuinely malformed spec file still fails loudly', async () => {
    // The empty-document guard must not become a catch-all: a real syntax error
    // carries a different reason and has to keep propagating.
    const { run } = await harnessFor('a:\n\t- [unclosed\n');

    expect(run).toThrow(/failed to load/);
  });

  test('a multi-document spec file still fails loudly', async () => {
    // Closest sibling of the guarded condition: this throws from the same function
    // over the same `documents` array, two lines below the empty-document throw. It
    // is the input a future loosening of the reason check would swallow first.
    const { run } = await harnessFor('a: 1\n---\nb: 2\n');

    expect(run).toThrow(/failed to load/);
  });

  test('a valid spec file is still parsed and served', async () => {
    const { app, run } = await harnessFor(
      'openapi: "3.0.0"\ninfo:\n  title: Test API\n  version: "1.0.0"\npaths: {}\n',
    );

    run();
    const handler = app._routes['/api/spec.json'];
    expect(handler).toBeDefined();
    let spec = null;
    handler({}, { json: (body) => { spec = body; } });
    expect(spec.openapi).toBe('3.0.0');
  });
});
