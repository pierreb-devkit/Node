/**
 * Unit tests for the public docs service.
 * Verifies tree assembly (driven by config.docs.guideSections), slug lookup,
 * the 404 (null) path, and TTL caching — with config + the docs-tree helper
 * mocked so the test never touches disk. (The tree parsing itself, including
 * the slug-collision precedence policy, is exercised in
 * public.docs.tree.unit.tests.js — this file only verifies that the service
 * wires `loadGuideEntries` → `resolveGuideEntries` → both `buildDocsTree` and
 * `bySlug`, so the two endpoints are built from the SAME deduped list.)
 */
import {
  jest, describe, test, expect, beforeEach,
} from '@jest/globals';

const guideFilesPaths = [
  'modules/home/doc/guides/00-welcome.md',
  'modules/home/doc/guides/01-quickstart.md',
];

const guideSections = [
  { title: 'Get Started', prefixMin: 0, prefixMax: 1 },
];

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    files: { guides: guideFilesPaths },
    docs: { guideSections },
  },
}));

// Stub the logger so the mocked config (no `log.fileLogger`) doesn't trip the
// real logger's file-logging bootstrap when the service is imported.
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: mockLogger,
}));

const loadGuideEntries = jest.fn();
const buildDocsTree = jest.fn();
const resolveGuideEntries = jest.fn();

jest.unstable_mockModule('../helpers/public.docs.tree.js', () => ({
  default: { loadGuideEntries, buildDocsTree, resolveGuideEntries },
}));

const PublicDocsService = (await import('../services/public.docs.service.js')).default;

const sampleEntries = [
  {
    slug: 'welcome', title: 'Welcome', order: 0, summary: 'w', body: 'Welcome body',
  },
  {
    slug: 'quickstart', title: 'Quickstart', order: 1, summary: 'q', body: 'Quickstart body',
  },
];
const sampleTree = { categories: [{ id: 'get-started', label: 'Get Started', order: 0, guides: [] }] };

describe('PublicDocsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PublicDocsService.clearCache();
    loadGuideEntries.mockReturnValue(sampleEntries);
    // Pass-through by default — collision resolution itself is unit-tested in
    // public.docs.tree.unit.tests.js; here we only verify the wiring.
    resolveGuideEntries.mockImplementation((entries) => entries);
    buildDocsTree.mockReturnValue(sampleTree);
  });

  test('getTree builds the tree from the configured guide files + sections, via resolveGuideEntries', () => {
    const tree = PublicDocsService.getTree();
    expect(loadGuideEntries).toHaveBeenCalledWith(guideFilesPaths);
    expect(resolveGuideEntries).toHaveBeenCalledWith(sampleEntries);
    expect(buildDocsTree).toHaveBeenCalledWith(sampleEntries, guideSections);
    expect(tree).toBe(sampleTree);
  });

  test('getMarkdown returns the body for a known slug', () => {
    expect(PublicDocsService.getMarkdown('quickstart')).toBe('Quickstart body');
  });

  test('getMarkdown returns null for an unknown slug', () => {
    expect(PublicDocsService.getMarkdown('does-not-exist')).toBeNull();
  });

  test('getMarkdown returns null for a non-string slug', () => {
    expect(PublicDocsService.getMarkdown(undefined)).toBeNull();
    expect(PublicDocsService.getMarkdown('')).toBeNull();
  });

  test('caches: a second call within the TTL does not recompute', () => {
    PublicDocsService.getTree();
    PublicDocsService.getTree();
    expect(loadGuideEntries).toHaveBeenCalledTimes(1);
  });

  test('clearCache forces a recompute on the next call', () => {
    PublicDocsService.getTree();
    PublicDocsService.clearCache();
    PublicDocsService.getTree();
    expect(loadGuideEntries).toHaveBeenCalledTimes(2);
  });

  test('bySlug is built from resolveGuideEntries output, not the raw loaded entries — tree and slug index cannot disagree', () => {
    const rawEntries = [
      {
        slug: 'quickstart', title: 'Quickstart A', order: 0, summary: 'a', body: 'Body A',
      },
      {
        slug: 'quickstart', title: 'Quickstart B', order: 1, summary: 'b', body: 'Body B',
      },
    ];
    // Collision already resolved upstream — resolveGuideEntries returns a
    // single winner, same as the real helper would.
    const deduped = [rawEntries[1]];
    loadGuideEntries.mockReturnValueOnce(rawEntries);
    resolveGuideEntries.mockReturnValueOnce(deduped);

    PublicDocsService.getTree();

    // buildDocsTree (the listing) receives the deduped list, not the raw one.
    expect(buildDocsTree).toHaveBeenCalledWith(deduped, guideSections);
    // bySlug (the fetch endpoint) agrees with the winner buildDocsTree saw.
    expect(PublicDocsService.getMarkdown('quickstart')).toBe('Body B');
  });
});
