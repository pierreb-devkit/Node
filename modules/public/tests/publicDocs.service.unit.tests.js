/**
 * Unit tests for the public docs service.
 * Verifies tree assembly (driven by config.docs.guideSections), slug lookup,
 * the 404 (null) path, and TTL caching — with config + the docs-tree helper
 * mocked so the test never touches disk. (The tree parsing itself is exercised
 * in publicDocs.tree.unit.tests.js.)
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

jest.unstable_mockModule('../helpers/publicDocs.tree.js', () => ({
  default: { loadGuideEntries, buildDocsTree },
}));

const PublicDocsService = (await import('../services/publicDocs.service.js')).default;

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
    buildDocsTree.mockReturnValue(sampleTree);
  });

  test('getTree builds the tree from the configured guide files + sections', () => {
    const tree = PublicDocsService.getTree();
    expect(loadGuideEntries).toHaveBeenCalledWith(guideFilesPaths);
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

  test('warns and last-wins when two entries share the same slug', () => {
    const dupeEntries = [
      {
        slug: 'quickstart', title: 'Quickstart A', order: 0, summary: 'a', body: 'Body A',
      },
      {
        slug: 'quickstart', title: 'Quickstart B', order: 1, summary: 'b', body: 'Body B',
      },
    ];
    loadGuideEntries.mockReturnValueOnce(dupeEntries);

    PublicDocsService.getTree();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('duplicate guide slug "quickstart"'),
    );
    // Last entry wins
    expect(PublicDocsService.getMarkdown('quickstart')).toBe('Body B');
  });
});
