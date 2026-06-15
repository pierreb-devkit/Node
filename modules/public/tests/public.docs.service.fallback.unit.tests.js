/**
 * Unit tests for the public docs service defensive config fallbacks.
 * With `config.files.guides` and `config.docs` absent, the service must resolve
 * to empty arrays (never throw) so the endpoint degrades to an empty tree
 * instead of crashing on a minimally-configured deployment.
 */
import {
  jest, describe, test, expect,
} from '@jest/globals';

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {}, // no `files`, no `docs`
}));

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  },
}));

jest.unstable_mockModule('../helpers/public.docs.tree.js', () => ({
  default: {
    loadGuideEntries: jest.fn().mockReturnValue([]),
    buildDocsTree: jest.fn().mockReturnValue({ categories: [] }),
  },
}));

const PublicDocsService = (await import('../services/public.docs.service.js')).default;

describe('PublicDocsService — config fallbacks (no files/docs):', () => {
  test('guideFiles returns [] when config.files.guides is absent', () => {
    expect(PublicDocsService._internals.guideFiles()).toEqual([]);
  });

  test('guideSections returns [] when config.docs.guideSections is absent', () => {
    expect(PublicDocsService._internals.guideSections()).toEqual([]);
  });

  test('getTree degrades to an empty tree instead of throwing', () => {
    PublicDocsService.clearCache();
    expect(PublicDocsService.getTree()).toEqual({ categories: [] });
  });
});
