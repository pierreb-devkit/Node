/**
 * Unit tests for the docs-tree helpers in
 * modules/public/helpers/public.docs.tree.js:
 * slugFromPath, prefixFromPath, moduleFromPath, titleFromMarkdown,
 * firstParagraph, loadGuideEntries, and buildDocsTree.
 *
 * These power the public docs content contract (GET /api/public/docs).
 * Category + persona come from the config grouping primitive
 * `config.docs.guideSections` (the same prefix-range grouping used to nest the
 * OpenAPI reference sidebar), NOT YAML front-matter: guide .md files carry no
 * front-matter, so each renders as plain prose starting with its H1.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import docsTree from '../helpers/public.docs.tree.js';

const {
  slugFromPath, prefixFromPath, moduleFromPath, titleFromMarkdown,
  firstParagraph, loadGuideEntries, buildDocsTree, DEFAULT_PERSONA,
} = docsTree;

const sections = [
  { title: 'Get Started', prefixMin: 0, prefixMax: 1 },
  { title: 'Guides', prefixMin: 2, prefixMax: 9, persona: ['agent'] },
];

describe('slugFromPath:', () => {
  it('strips the numeric prefix and .md extension', () => {
    expect(slugFromPath('/x/01-quickstart.md')).toBe('quickstart');
    expect(slugFromPath('/x/12-api-keys.md')).toBe('api-keys');
  });

  it('keeps the basename when there is no numeric prefix', () => {
    expect(slugFromPath('/x/welcome.md')).toBe('welcome');
  });
});

describe('prefixFromPath:', () => {
  it('extracts the leading numeric prefix', () => {
    expect(prefixFromPath('/x/07-scheduling.md')).toBe(7);
    expect(prefixFromPath('/x/14-cli.md')).toBe(14);
  });

  it('returns null when there is no numeric prefix', () => {
    expect(prefixFromPath('/x/welcome.md')).toBeNull();
  });
});

describe('moduleFromPath:', () => {
  it('extracts the module name from a guide path', () => {
    expect(moduleFromPath('modules/home/doc/guides/01-quickstart.md')).toBe('home');
    expect(moduleFromPath('/abs/modules/users/doc/guides/12-api-keys.md')).toBe('users');
  });

  it('returns null when the path is not under modules/', () => {
    expect(moduleFromPath('/tmp/foo.md')).toBeNull();
  });
});

describe('titleFromMarkdown:', () => {
  it('derives the title from the first H1', () => {
    expect(titleFromMarkdown('# Getting Started\n\nBody.', 'welcome')).toBe('Getting Started');
  });

  it('falls back to a title-cased slug when there is no H1', () => {
    expect(titleFromMarkdown('Just prose, no heading.', 'api-keys')).toBe('Api Keys');
  });
});

describe('firstParagraph:', () => {
  it('returns the first prose paragraph, skipping headings and HTML anchors', () => {
    const md = '<a id="x"></a>\n\nReal first para.\nSecond line.\n\nNext para.';
    expect(firstParagraph(md)).toBe('Real first para. Second line.');
  });

  it('returns an empty string when there is no prose', () => {
    expect(firstParagraph('# Only a heading\n')).toBe('');
  });
});

describe('loadGuideEntries:', () => {
  let dir;
  /**
   * Write a fixture guide file into the per-suite temp dir.
   * @param {string} name - File name (e.g. `01-quickstart.md`).
   * @param {string} content - Raw markdown body.
   * @returns {void}
   */
  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-docs-tree-'));
    // No front-matter — files start with their H1 (matches the real guides).
    write('01-quickstart.md', '# Quickstart\n\nGet going fast.\n');
    write('99-unmapped.md', '# Unmapped\n\nDeep dive.\n');
    write('empty.md', '   \n');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns structured entries with slug/title/persona/order/summary/body/path', () => {
    const entries = loadGuideEntries([path.join(dir, '01-quickstart.md')]);
    expect(entries).toHaveLength(1);
    const qs = entries[0];
    expect(qs.slug).toBe('quickstart');
    expect(qs.title).toBe('Quickstart'); // H1-derived
    expect(qs.order).toBe(1);
    expect(qs.summary).toBe('Get going fast.');
    expect(qs.body).toBe('Get going fast.'); // H1 stripped
    expect(qs.path).toContain('01-quickstart.md');
  });

  it('skips empty guides without throwing', () => {
    expect(loadGuideEntries([path.join(dir, 'empty.md')])).toEqual([]);
  });

  it('skips unreadable files without throwing', () => {
    expect(loadGuideEntries([path.join(dir, 'does-not-exist.md')])).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(loadGuideEntries([])).toEqual([]);
    expect(loadGuideEntries(null)).toEqual([]);
  });

  it('sorts entries by numeric filename prefix', () => {
    const entries = loadGuideEntries([
      path.join(dir, '99-unmapped.md'),
      path.join(dir, '01-quickstart.md'),
    ]);
    expect(entries.map((e) => e.slug)).toEqual(['quickstart', 'unmapped']);
  });
});

describe('buildDocsTree:', () => {
  const entries = [
    {
      slug: 'welcome', title: 'Welcome', order: 0, summary: 's', path: 'modules/home/doc/guides/00-welcome.md',
    },
    {
      slug: 'quickstart', title: 'Quickstart', order: 1, summary: 's', path: 'modules/home/doc/guides/01-quickstart.md',
    },
    {
      slug: 'advanced', title: 'Advanced', order: 3, summary: 's', path: 'modules/home/doc/guides/03-advanced.md',
    },
  ];

  it('groups guides under their section category with id/label/order/guides', () => {
    const { categories } = buildDocsTree(entries, sections);
    const ids = categories.map((c) => c.id);
    expect(ids).toEqual(['get-started', 'guides']);
    expect(categories[0].label).toBe('Get Started');
    expect(typeof categories[0].order).toBe('number');
    expect(categories[0].guides).toHaveLength(2);
    // Guide projection drops body/path — keeps the public contract.
    expect(categories[0].guides[0]).toEqual({
      slug: 'welcome', title: 'Welcome', persona: DEFAULT_PERSONA, order: 0, summary: 's',
    });
  });

  it('applies the per-section persona override when present', () => {
    const { categories } = buildDocsTree(entries, sections);
    const guidesCat = categories.find((c) => c.id === 'guides');
    expect(guidesCat.guides[0].persona).toEqual(['agent']);
  });

  it('defaults persona to the neutral DEFAULT_PERSONA when the section sets none', () => {
    const { categories } = buildDocsTree(entries, sections);
    expect(categories[0].guides[0].persona).toEqual(DEFAULT_PERSONA);
  });

  it('preserves section order (config order) and within-category order', () => {
    const { categories } = buildDocsTree(entries, sections);
    expect(categories[0].guides.map((g) => g.slug)).toEqual(['welcome', 'quickstart']);
    expect(categories[1].guides.map((g) => g.slug)).toEqual(['advanced']);
  });

  it('falls back to the capitalised module name when no section matches', () => {
    const orphan = [{
      slug: 'lonely', title: 'Lonely', order: 99, summary: 's', path: 'modules/users/doc/guides/99-lonely.md',
    }];
    const { categories } = buildDocsTree(orphan, sections);
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('users');
    expect(categories[0].label).toBe('Users');
    expect(categories[0].guides[0].persona).toEqual(DEFAULT_PERSONA);
  });

  it('falls back to the module name when a guide has no numeric prefix (no section match)', () => {
    const unprefixed = [{
      slug: 'overview', title: 'Overview', order: 0, summary: 's', path: 'modules/home/doc/guides/overview.md',
    }];
    const { categories } = buildDocsTree(unprefixed, sections);
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('home');
    expect(categories[0].guides[0].persona).toEqual(DEFAULT_PERSONA);
  });

  it('falls back to a generic Guides category when a guide path is not under modules/', () => {
    const detached = [{
      slug: 'loose', title: 'Loose', order: 5, summary: 's', path: '/tmp/loose.md',
    }];
    const { categories } = buildDocsTree(detached, sections);
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('guides');
    expect(categories[0].label).toBe('Guides');
  });

  it('falls back to a single generic Guides category when no sections are configured', () => {
    const { categories } = buildDocsTree(entries, []);
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('home');
    expect(categories[0].guides).toHaveLength(3);
  });

  it('returns an empty tree for empty/invalid input', () => {
    expect(buildDocsTree([], sections)).toEqual({ categories: [] });
    expect(buildDocsTree(null, sections)).toEqual({ categories: [] });
  });
});
