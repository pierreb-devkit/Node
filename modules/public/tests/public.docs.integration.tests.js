/**
 * Integration tests — GET /api/public/docs and GET /api/public/docs/:slug.md.
 * Drives the real Express app end-to-end, unauthenticated, against CONTROLLED
 * fixture guides — never the repo's real on-disk `modules/home/doc/guides/*.md`
 * samples. A downstream consumer can ship its own guides at any slug (including
 * `welcome`/`quickstart`, which a consumer legitimately owns/overrides — see
 * the slug-collision precedence block below) without ever changing the outcome
 * of these tests. Content-agnostic tests (status/shape only, no slug or guide
 * count) are the one exception: they run against whatever `config.files.guides`
 * already resolves to, real or consumer-provided, because the assertion holds
 * either way.
 */
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import {
  jest, afterAll, beforeAll, beforeEach, describe, test, expect,
} from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';
import logger from '../../../lib/services/logger.js';

describe('Public docs integration tests — shape/status only:', () => {
  let app;
  const originalOrgEnabled = config.organizations?.enabled;

  beforeAll(async () => {
    if (config.organizations) config.organizations.enabled = false;
    const init = await bootstrap();
    app = init.app;
  });

  afterAll(async () => {
    if (config.organizations) config.organizations.enabled = originalOrgEnabled;
    await mongooseService.disconnect();
  });

  // No slug, no guide count, no title/persona assertion — passes regardless of
  // which guides are on disk, so no fixture setup is needed here.
  test('GET /api/public/docs is publicly accessible without authentication', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    expect(result.body.type).toBe('success');
    expect(result.body.message).toBe('public docs');
  });

  test('GET /api/public/docs/:slug.md returns 404 for an unknown slug', async () => {
    const result = await request(app).get('/api/public/docs/does-not-exist.md').expect(404);
    expect(result.body.type).toBe('error');
    expect(result.body.status).toBe(404);
  });
});

describe('Public docs integration tests — controlled guide fixtures:', () => {
  let app;
  let PublicDocsService;
  let tmpDir;
  const originalOrgEnabled = config.organizations?.enabled;
  const originalGuides = Array.isArray(config.files?.guides) ? [...config.files.guides] : [];

  // Two guides feed the tree/category assertions below — numeric prefixes
  // 00/01, inside the default `guideSections` "Get Started" range [0,9]. A
  // third, unrelated guide at a unique slug and an out-of-range prefix (so it
  // never lands in "Get Started") feeds the raw-markdown fetch test. All three
  // live under a synthetic, non-core module directory — replicating a
  // consumer's own `doc/guides/` folder, never the framework's `modules/home`.
  const treeGuideOneRel = path.join('modules', 'fixture-docs', 'doc', 'guides', '00-sample-intro.md');
  const treeGuideTwoRel = path.join('modules', 'fixture-docs', 'doc', 'guides', '01-sample-next.md');
  const rawMarkdownGuideRel = path.join('modules', 'fixture-docs', 'doc', 'guides', '99-raw-markdown-check.md');
  const rawMarkdownMarker = 'FIXTURE_RAW_MARKDOWN_MARKER';

  beforeAll(async () => {
    if (config.organizations) config.organizations.enabled = false;
    const init = await bootstrap();
    app = init.app;
    PublicDocsService = (await import(path.resolve('./modules/public/services/public.docs.service.js'))).default;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-docs-fixtures-'));
    fs.mkdirSync(path.dirname(path.join(tmpDir, treeGuideOneRel)), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, treeGuideOneRel),
      '# Sample Intro\n\nFirst fixture guide for the docs integration suite.\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, treeGuideTwoRel),
      '# Sample Next\n\nSecond fixture guide for the docs integration suite.\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, rawMarkdownGuideRel),
      `# Raw Markdown Check\n\nBody contains a fixture-only marker: ${rawMarkdownMarker}.\n`,
    );

    // Fully replaced, not appended to the real on-disk guides — the #4014
    // pattern: this block controls its own input end to end.
    config.files.guides = [
      path.join(tmpDir, treeGuideOneRel),
      path.join(tmpDir, treeGuideTwoRel),
      path.join(tmpDir, rawMarkdownGuideRel),
    ];
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

  test('the tree groups fixture guides into categories via the configured guide sections', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    const { categories } = result.body.data;
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);

    const guides = categories.flatMap((c) => c.guides);

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

    // The two prefix-00/01 fixture guides are present, no duplicate slugs.
    const slugs = guides.map((g) => g.slug);
    expect(slugs).toContain('sample-intro');
    expect(slugs).toContain('sample-next');
    expect(new Set(slugs).size).toBe(slugs.length);

    // The default config groups both fixture guides under "Get Started"
    // (prefix range [0,9], neutral persona ['all']) — asserts the REAL grouping
    // primitive against controlled content, not a self-authored mock of it.
    const sampleIntro = guides.find((g) => g.slug === 'sample-intro');
    expect(sampleIntro.title).toBe('Sample Intro');
    expect(sampleIntro.persona).toEqual(['all']);
    const getStarted = categories.find((c) => c.id === 'get-started');
    expect(getStarted).toBeDefined();
    expect(getStarted.label).toBe('Get Started');
    expect(getStarted.guides.map((g) => g.slug)).toEqual(
      expect.arrayContaining(['sample-intro', 'sample-next']),
    );
  });

  test('GET /api/public/docs/:slug.md returns raw markdown for a fixture guide at a unique slug', async () => {
    const result = await request(app).get('/api/public/docs/raw-markdown-check.md').expect(200);
    expect(result.headers['content-type']).toMatch(/text\/markdown/);
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    // The H1 was stripped by the loader.
    expect(result.text).not.toMatch(/^#\s/);
    // Asserts the fixture's OWN content, never a real shipped guide's — a
    // consumer overriding this (or any other) slug can never break this.
    expect(result.text).toContain(rawMarkdownMarker);
  });

  test('the docs tree never leaks raw YAML front-matter into a fixture guide body', async () => {
    const result = await request(app).get('/api/public/docs/sample-intro.md').expect(200);
    expect(result.text.trimStart().startsWith('---')).toBe(false);
  });
});

describe('Public docs integration tests — slug-collision precedence:', () => {
  let app;
  let PublicDocsService;
  let debugSpy;
  let tmpDir;
  let appGuidePath;
  let reverseFixtureAbsDir;
  let reverseFixtureAbsPath;
  let reverseGuideRelPath;
  const originalOrgEnabled = config.organizations?.enabled;
  const originalGuides = Array.isArray(config.files?.guides) ? [...config.files.guides] : [];

  beforeAll(async () => {
    if (config.organizations) config.organizations.enabled = false;
    const init = await bootstrap();
    app = init.app;
    PublicDocsService = (await import(path.resolve('./modules/public/services/public.docs.service.js'))).default;
    debugSpy = jest.spyOn(logger, 'debug');

    // A real on-disk fixture guide, under a module path other than "home" —
    // simulates a consumer/application module shipping its own "welcome"
    // guide, colliding with the framework-shipped modules/home/00-welcome.md.
    // Path substring only needs to contain "modules/<name>/", it does not
    // need to live under the app's real modules/ directory. loadGuideEntries
    // sorts ALL guide paths alphabetically before assigning scan order, and an
    // absolute OS-tmpdir path always sorts before the relative "modules/..."
    // path config.files.guides uses for real guides — so this fixture is
    // scanned BEFORE modules/home/00-welcome.md (app is the earlier entry,
    // already-incumbent when the framework guide arrives as challenger — the
    // SILENT "incumbent already wins" branch in resolveGuideEntries, no
    // logger.debug call).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-docs-precedence-'));
    const appModuleDir = path.join(tmpDir, 'modules', 'app-fixture', 'doc', 'guides');
    fs.mkdirSync(appModuleDir, { recursive: true });
    appGuidePath = path.join(appModuleDir, '00-welcome.md');
    fs.writeFileSync(appGuidePath, '# App Welcome\n\nApplication-level welcome guide.\n');

    // Second fixture, deliberately scanned in the OPPOSITE direction. The
    // file is still written at an absolute path (fs calls need one), but the
    // string pushed into config.files.guides below is made GENUINELY
    // relative via path.relative() — path.join(process.cwd(), ...) is
    // ALWAYS absolute (an earlier version of this test wrongly assumed
    // otherwise, so both fixtures ended up absolute and this direction was
    // never actually exercised — caught by review). A relative string
    // starting with "zzz-" sorts AFTER "modules/home/...", so THIS fixture
    // is scanned AFTER modules/home/01-quickstart.md: the framework guide is
    // incumbent, the app guide is the LATER challenger that must explicitly
    // override it — the logger.debug branch in resolveGuideEntries, asserted
    // below.
    reverseFixtureAbsDir = path.join(process.cwd(), 'zzz-tmp-pr3979-fixture', 'doc', 'guides');
    fs.mkdirSync(reverseFixtureAbsDir, { recursive: true });
    reverseFixtureAbsPath = path.join(reverseFixtureAbsDir, '01-quickstart.md');
    fs.writeFileSync(reverseFixtureAbsPath, '# App Quickstart\n\nApplication-level quickstart guide.\n');
    reverseGuideRelPath = path.relative(process.cwd(), reverseFixtureAbsPath);

    // The block fully controls its own input — no `...originalGuides` spread.
    // Spreading the real on-disk `config.files.guides` implicitly assumed at
    // most one real guide per slug (the framework's own `modules/home/`); a
    // downstream consumer shipping a second real guide at the same slug from
    // its own (non-core) module lands at the SAME precedence tier as this
    // fixture and silently wins the same-tier tiebreak, defeating the test
    // (#4012). The two framework sample guides these fixtures collide
    // against are listed explicitly instead, by their known real path — both
    // cross-tier assertions below need a framework guide actually present
    // (as the silently-losing incumbent for "welcome", the explicitly
    // overridden incumbent for "quickstart"), so removing the spread can't
    // also drop them.
    const frameworkWelcomeGuide = 'modules/home/doc/guides/00-welcome.md';
    const frameworkQuickstartGuide = 'modules/home/doc/guides/01-quickstart.md';

    config.files.guides = [
      frameworkWelcomeGuide,
      frameworkQuickstartGuide,
      appGuidePath,
      reverseGuideRelPath,
    ];
  });

  afterAll(async () => {
    if (config.organizations) config.organizations.enabled = originalOrgEnabled;
    config.files.guides = originalGuides;
    if (debugSpy) debugSpy.mockRestore();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (reverseFixtureAbsDir) fs.rmSync(path.join(process.cwd(), 'zzz-tmp-pr3979-fixture'), { recursive: true, force: true });
    await mongooseService.disconnect();
  });

  beforeEach(() => {
    if (PublicDocsService) PublicDocsService.clearCache();
    if (debugSpy) debugSpy.mockClear();
  });

  test('the application guide wins the "welcome" slug in the listing (no duplicate) — app scanned BEFORE the framework guide (silent "incumbent already wins" branch)', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    const { categories } = result.body.data;
    const guides = categories.flatMap((c) => c.guides);
    const welcomeGuides = guides.filter((g) => g.slug === 'welcome');

    // Exactly one "welcome" entry — the listing never shows a duplicate.
    expect(welcomeGuides).toHaveLength(1);
    expect(welcomeGuides[0].title).toBe('App Welcome');

    // This direction wins because the app guide is already incumbent — it
    // does NOT go through the explicit override branch (that's proven
    // separately by the "quickstart" case below). Scope the assertion to
    // "welcome" specifically: the same compute() pass also resolves the
    // quickstart collision (both fixtures share one config.files.guides),
    // which DOES log — asserting a blanket "not called" here would be a
    // false negative.
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('guide slug "welcome"'));
  });

  test('the application guide wins the "welcome" slug on fetch — listing and fetch agree', async () => {
    const result = await request(app).get('/api/public/docs/welcome.md').expect(200);
    expect(result.text).toContain('Application-level welcome guide.');
    expect(result.text).not.toContain('Welcome to');
  });

  test('the application guide overrides the framework guide for "quickstart" — app scanned AFTER it (opposite scan-order direction), proven via the explicit override branch firing', async () => {
    const result = await request(app).get('/api/public/docs').expect(200);
    const { categories } = result.body.data;
    const guides = categories.flatMap((c) => c.guides);
    const quickstartGuides = guides.filter((g) => g.slug === 'quickstart');

    expect(quickstartGuides).toHaveLength(1);
    expect(quickstartGuides[0].title).toBe('App Quickstart');

    const fetchResult = await request(app).get('/api/public/docs/quickstart.md').expect(200);
    expect(fetchResult.text).toContain('Application-level quickstart guide.');
    expect(fetchResult.text).not.toContain('<YOUR_API_KEY>');

    // Proof this exercised the explicit "challenger overrides incumbent"
    // branch in resolveGuideEntries (public.docs.tree.js) — that branch is
    // the ONLY place this debug line is emitted, so its presence is direct
    // evidence the framework guide was incumbent and the app guide, scanned
    // later, actively overrode it (not merely "already winning").
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('guide slug "quickstart"'),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('overrides framework guide'),
    );
  });
});
