/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import docsTree from '../helpers/publicDocs.tree.js';
import logger from '../../../lib/services/logger.js';

/**
 * @desc Cache TTL in ms. The docs tree is built from on-disk markdown that only
 * changes on deploy, so a short staleness window is plenty — it keeps the
 * unauthenticated endpoint cheap under burst while still picking up a redeploy
 * within a few minutes.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @type {{ tree: Object, bySlug: Map<string, Object>, expiresAt: number }|null}
 * Single-slot TTL cache holding both the assembled tree (for `/docs`) and a
 * slug→entry index (for `/docs/:slug.md`). Process-local; multi-replica
 * deployments each maintain their own copy, which is fine because the payload
 * is read-only and idempotent.
 */
let cacheEntry = null;

/**
 * @desc Resolve the configured guide file paths. Returns a defensive copy so a
 * caller can never mutate config state.
 * @returns {string[]} Absolute guide markdown paths (empty array when unset).
 */
const guideFiles = () => (Array.isArray(config.files?.guides) ? config.files.guides : []);

/**
 * @desc Resolve the configured guide sections grouping primitive
 * (`config.docs.guideSections`). Empty array when unset → guides fall back to
 * module-name grouping in the tree builder.
 * @returns {{ title: string, prefixMin: number, prefixMax: number, persona?: string[] }[]}
 */
const guideSections = () => (Array.isArray(config.docs?.guideSections) ? config.docs.guideSections : []);

/**
 * @desc Build the docs tree + slug index from disk.
 * @returns {{ tree: { categories: Object[] }, bySlug: Map<string, Object> }}
 */
const compute = () => {
  const entries = docsTree.loadGuideEntries(guideFiles());
  const tree = docsTree.buildDocsTree(entries, guideSections());
  const bySlug = new Map();
  for (const entry of entries) {
    if (bySlug.has(entry.slug)) {
      logger.warn(`[public/docs] duplicate guide slug "${entry.slug}" — later guide wins; rename one to avoid the collision`);
    }
    bySlug.set(entry.slug, entry);
  }
  return { tree, bySlug };
};

/**
 * @desc Return the cached tree+index or recompute when the TTL has elapsed.
 * @param {Object} [options]
 * @param {boolean} [options.bypassCache] - Skip the cache lookup (for tests).
 * @returns {{ tree: { categories: Object[] }, bySlug: Map<string, Object> }}
 */
const load = ({ bypassCache = false } = {}) => {
  if (!bypassCache && cacheEntry && cacheEntry.expiresAt > Date.now()) {
    logger.debug('public.docs - cache hit');
    return cacheEntry;
  }
  // No inflight guard needed: compute() is fully synchronous (fs.readFileSync,
  // no await), so there is no gap between the staleness check and the cache
  // assignment on Node's event loop — stampede is impossible. If compute() is
  // ever made async, an inflight guard must be added.
  const { tree, bySlug } = compute();
  cacheEntry = { tree, bySlug, expiresAt: Date.now() + CACHE_TTL_MS };
  logger.info('public.docs - recomputed', {
    event: 'public.docs.refresh',
    categories: tree.categories.length,
    guides: bySlug.size,
  });
  return cacheEntry;
};

/**
 * @desc Return the public docs tree: `{ categories: [{ id, label, order, guides }] }`.
 * Each guide is `{ slug, title, persona, order, summary }`.
 * @returns {{ categories: Object[] }} Docs tree payload.
 */
const getTree = () => load().tree;

/**
 * @desc Return the raw markdown body for a guide slug, or null when unknown.
 * The body has the leading H1 already stripped — it is the prose a consumer
 * renders. Guides carry no YAML front-matter, so the body starts at the prose.
 * @param {string} slug - Guide slug (e.g. `quickstart`).
 * @returns {string|null} Markdown body, or null when the slug is unknown.
 */
const getMarkdown = (slug) => {
  if (typeof slug !== 'string' || !slug) return null;
  const entry = load().bySlug.get(slug);
  return entry ? entry.body : null;
};

/**
 * @desc Clear the in-memory cache. Exposed for tests and admin tooling.
 * @returns {void}
 */
const clearCache = () => {
  cacheEntry = null;
};

export default {
  getTree,
  getMarkdown,
  clearCache,
  // Exposed for unit tests — not part of the public API.
  _internals: { CACHE_TTL_MS, compute, guideFiles, guideSections },
};
