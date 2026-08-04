/**
 * Integration tests — GET /api/public/docs and GET /api/public/docs/:slug.md.
 * Drives the real Express app against the on-disk markdown guides (the two
 * shipped sample guides: welcome + quickstart) so the whole content contract
 * (tree shape, real grouping, raw markdown, 404) is exercised end-to-end,
 * unauthenticated. The expectations assert the REAL wire shape against the REAL
 * sample guides — not a self-authored mock.
 */
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import {
  afterAll, beforeAll, beforeEach, describe, test, expect,
} from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

describe('Public docs integration tests:', () => {
  let app;
  let PublicDocsService;
  const originalOrgEnabled = config.organizations?.enabled;

  beforeAll(async () => {
    if (config.organizations) config.organizations.enabled = false;
    const init = await bootstrap();
    app = init.app;
    PublicDocsService = (await import(path.resolve('./modules/public/services/public.docs.service.js'))).default;
  });

  afterAll(async () => {
    if (config.organizations) config.organizations.enabled = originalOrgEnabled;
    await mongooseService.disconnect();
  });

  beforeEach(() => {
    if (PublicDocsService) PublicDocsService.clearCache();
  });

  test('GET /api/public/docs is publicly accessible without authentication', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    expect(result.body.type).toBe('success');
    expect(result.body.message).toBe('public docs');
  });

  test('the tree contains the shipped sample guides grouped into categories', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    const { categories } = result.body.data;
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);

    const guides = categories.flatMap((c) => c.guides);
    // Devkit ships exactly two sample guides out of the box.
    expect(guides.length).toBeGreaterThanOrEqual(2);

    // Every guide carries the structured contract fields.
    for (const guide of guides) {
      expect(typeof guide.slug).toBe('string');
      expect(guide.slug.length).toBeGreaterThan(0);
      expect(typeof guide.title).toBe('string');
      expect(Array.isArray(guide.persona)).toBe(true);
      expect(typeof guide.order).toBe('number');
      expect(typeof guide.summary).toBe('string');
    }

    // Every category exposes id + label + order.
    for (const cat of categories) {
      expect(typeof cat.id).toBe('string');
      expect(typeof cat.label).toBe('string');
      expect(typeof cat.order).toBe('number');
    }

    // The two shipped sample guides are present.
    const slugs = guides.map((g) => g.slug);
    expect(slugs).toContain('welcome');
    expect(slugs).toContain('quickstart');
    // No duplicate slugs.
    expect(new Set(slugs).size).toBe(slugs.length);

    // The default config groups both samples under the "Get Started" section
    // (neutral persona ['all']) — assert the real grouping, not a mock.
    const welcome = guides.find((g) => g.slug === 'welcome');
    expect(welcome.title).toBe('Welcome');
    expect(welcome.persona).toEqual(['all']);
    const getStarted = categories.find((c) => c.id === 'get-started');
    expect(getStarted).toBeDefined();
    expect(getStarted.label).toBe('Get Started');
    expect(getStarted.guides.map((g) => g.slug)).toEqual(
      expect.arrayContaining(['welcome', 'quickstart']),
    );
  });

  test('GET /api/public/docs/:slug.md returns raw markdown for a known slug', async () => {
    const result = await request(app).get('/api/public/docs/quickstart.md').expect(200);
    expect(result.headers['content-type']).toMatch(/text\/markdown/);
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    // The H1 was stripped by the loader.
    expect(result.text).not.toMatch(/^#\s/);
    // The real quickstart body uses a generic placeholder API key.
    expect(result.text).toContain('<YOUR_API_KEY>');
  });

  test('GET /api/public/docs/:slug.md returns 404 for an unknown slug', async () => {
    const result = await request(app).get('/api/public/docs/does-not-exist.md').expect(404);
    expect(result.body.type).toBe('error');
    expect(result.body.status).toBe(404);
  });

  test('the docs tree never leaks raw YAML front-matter into a guide body', async () => {
    const result = await request(app).get('/api/public/docs/welcome.md').expect(200);
    expect(result.text.trimStart().startsWith('---')).toBe(false);
  });
});

describe('Public docs integration tests — slug-collision precedence:', () => {
  let app;
  let PublicDocsService;
  let tmpDir;
  let appGuidePath;
  const originalOrgEnabled = config.organizations?.enabled;
  const originalGuides = Array.isArray(config.files?.guides) ? [...config.files.guides] : [];

  beforeAll(async () => {
    if (config.organizations) config.organizations.enabled = false;
    const init = await bootstrap();
    app = init.app;
    PublicDocsService = (await import(path.resolve('./modules/public/services/public.docs.service.js'))).default;

    // A real on-disk fixture guide, under a module path other than "home" —
    // simulates a consumer/application module shipping its own "welcome"
    // guide, colliding with the framework-shipped modules/home/00-welcome.md.
    // Path substring only needs to contain "modules/<name>/", it does not
    // need to live under the app's real modules/ directory.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-docs-precedence-'));
    const appModuleDir = path.join(tmpDir, 'modules', 'app-fixture', 'doc', 'guides');
    fs.mkdirSync(appModuleDir, { recursive: true });
    appGuidePath = path.join(appModuleDir, '00-welcome.md');
    fs.writeFileSync(appGuidePath, '# App Welcome\n\nApplication-level welcome guide.\n');

    config.files.guides = [...originalGuides, appGuidePath];
  });

  afterAll(async () => {
    if (config.organizations) config.organizations.enabled = originalOrgEnabled;
    config.files.guides = originalGuides;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await mongooseService.disconnect();
  });

  beforeEach(() => {
    if (PublicDocsService) PublicDocsService.clearCache();
  });

  test('the application guide wins the "welcome" slug in the listing (no duplicate)', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    const { categories } = result.body.data;
    const guides = categories.flatMap((c) => c.guides);
    const welcomeGuides = guides.filter((g) => g.slug === 'welcome');

    // Exactly one "welcome" entry — the listing never shows a duplicate.
    expect(welcomeGuides).toHaveLength(1);
    expect(welcomeGuides[0].title).toBe('App Welcome');
  });

  test('the application guide wins the "welcome" slug on fetch — listing and fetch agree', async () => {
    const result = await request(app).get('/api/public/docs/welcome.md').expect(200);
    expect(result.text).toContain('Application-level welcome guide.');
    expect(result.text).not.toContain('Welcome to');
  });
});
