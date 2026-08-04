/**
 * Docs content-contract parser for the public docs API (GET /api/public/docs).
 *
 * Lives in the `public` module (NOT the stack `lib/helpers/guides.js`) on
 * purpose: `guides.js` owns the flat/sectioned markdown merge into the OpenAPI
 * `info.description` (for `/api/spec.json`), while this module owns the richer
 * `{ categories: [{ id, label, order, guides }] }` contract that backs the
 * structured public docs endpoint.
 *
 * Guides are discovered from the same on-disk source as the OpenAPI reference
 * (`config.files.guides`, globbed from `modules/&#42;/doc/guides/&#42;.md` via
 * `config/assets.js`). They carry no YAML front-matter, so each renders as
 * plain prose starting with its H1.
 *
 * Category + persona come from the config grouping primitive
 * `config.docs.guideSections` (`{ title, prefixMin, prefixMax }`), which groups the
 * public docs contract. A section may additionally
 * declare a `persona` array to narrow the audience; absent that, guides target
 * every audience ({@link DEFAULT_PERSONA}). A guide whose prefix falls outside
 * every configured range (or when no sections are configured) is grouped under
 * its capitalised module name so it is never silently dropped.
 *
 * A slug collision between two guide files is resolved by {@link resolveGuideEntries}
 * BEFORE the tree is built, using a precedence policy (application-level guide
 * overrides a framework-provided one) — see that function for details. The
 * caller (the public docs service) runs the same deduped list through both
 * `buildDocsTree` and its slug index, so the two endpoints can never disagree.
 */
import fs from 'fs';
import path from 'path';

import logger from '../../../lib/services/logger.js';

/**
 * Default persona audience applied when a section declares none.
 * Guides target every audience unless a section narrows them.
 * @type {readonly string[]}
 */
const DEFAULT_PERSONA = Object.freeze(['all']);

/**
 * Derive the public slug for a guide from its file path: filename minus the
 * numeric ordering prefix and the `.md` extension.
 * E.g. `01-quickstart.md` → `quickstart`, `12-api-keys.md` → `api-keys`.
 * Falls back to the full basename when stripping the prefix would empty it.
 * @param {string} filePath - Absolute or relative path to the guide file.
 * @returns {string} URL-safe guide slug.
 */
// Guide filenames are expected to be `NN-kebab-name.md` (numeric prefix + kebab); the prefix is stripped for the slug.
const slugFromPath = (filePath) => {
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const stripped = base.replace(/^\d+[-_]/, '');
  return stripped || base;
};

/**
 * Extract the leading numeric prefix from a guide file path.
 * E.g. `/foo/07-scheduling.md` → 7, `/foo/14-cli.md` → 14.
 * Returns null when the basename has no numeric prefix.
 * @param {string} filePath - Absolute or relative path to the guide file.
 * @returns {number|null} Numeric prefix, or null if not present.
 */
const prefixFromPath = (filePath) => {
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const m = base.match(/^(\d+)[-_]/);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * Derive the module name from a guide file path.
 * E.g. `modules/home/doc/guides/01-quickstart.md` → `home`.
 * Used as the fallback category when a guide matches no configured section.
 * @param {string} filePath - Absolute or relative path to the guide file.
 * @returns {string|null} Module name, or null when not under `modules/`.
 */
const moduleFromPath = (filePath) => {
  const norm = String(filePath).replace(/\\/g, '/');
  const m = norm.match(/modules\/([^/]+)\//);
  return m ? m[1] : null;
};

/**
 * Derive the guide title from the first markdown H1 (`# Title`).
 * Falls back to a title-cased slug when the body has no leading H1, so a guide
 * is never emitted with an empty title.
 * @param {string} markdown - Raw markdown content (front-matter-free).
 * @param {string} slug - Guide slug, used for the fallback title.
 * @returns {string} Guide title.
 */
const titleFromMarkdown = (markdown, slug) => {
  const m = String(markdown).match(/^\s*#\s+([^\n]+?)\s*$/m);
  if (m && m[1].trim()) return m[1].trim();
  return String(slug)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Strip the first H1 heading from a markdown body (if present), mirroring the
 * stack loader so the raw-markdown endpoint returns prose only.
 * @param {string} markdown - Raw markdown content.
 * @returns {string} Markdown without the leading H1.
 */
const stripLeadingH1 = (markdown) => String(markdown).replace(/^\s*#\s+[^\n]*\n+/, '');

/**
 * Extract the first prose paragraph from a markdown body to use as a summary.
 * Skips blank lines, ATX headings (`#`), HTML anchor lines (`<a id=...>`),
 * blockquotes, and code fences, then collects consecutive non-blank lines until
 * the next blank line. Returns an empty string when no prose paragraph is found.
 * @param {string} markdown - Markdown body (H1 already stripped).
 * @returns {string} First paragraph as a single trimmed line.
 */
const firstParagraph = (markdown) => {
  const lines = String(markdown).split(/\r?\n/);
  const buffer = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (buffer.length === 0) {
      // Skip leading non-prose: blanks, headings, HTML, blockquotes, fences.
      if (!trimmed) continue;
      if (/^(#{1,6}\s|<|>|```|---)/.test(trimmed)) continue;
      buffer.push(trimmed);
      continue;
    }
    if (!trimmed) break;
    buffer.push(trimmed);
  }
  return buffer.join(' ').trim();
};

/**
 * Load markdown guides as structured per-guide entries for the public docs API.
 *
 * Each entry: `{ slug, title, order, summary, body, path }`.
 *   - `slug`     filename minus numeric prefix + `.md`
 *   - `title`    first markdown H1 (fallback: title-cased slug)
 *   - `order`    filename numeric prefix (fallback: discovery index)
 *   - `summary`  first prose paragraph
 *   - `body`     prose with the leading H1 stripped
 *   - `path`     source file path (used for module-name grouping fallback)
 *
 * Persona + category are NOT decided here — they are derived per-section at
 * tree-assembly time (see {@link buildDocsTree}).
 *
 * Invalid/unreadable/empty files are skipped with a warning so one broken guide
 * cannot take down the docs endpoint.
 *
 * @param {string[]} filePaths - Absolute paths to `.md` guide files.
 * @returns {{ slug: string, title: string, order: number, summary: string,
 *   body: string, path: string }[]} Structured guides, sorted by numeric
 *   filename prefix (stable, deterministic tiebreak by slug).
 */
const loadGuideEntries = (filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  // Sort deterministically before mapping so the fallback `index` for
  // unprefixed guides is stable across platforms (glob order is not guaranteed).
  return [...filePaths].sort()
    .map((filePath, index) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const slug = slugFromPath(filePath);
        const title = titleFromMarkdown(raw, slug);
        const body = stripLeadingH1(raw).trim();
        if (!body) {
          logger.warn(`[public.docs] skipping ${filePath}: empty markdown content`);
          return null;
        }
        const prefix = prefixFromPath(filePath);
        return {
          slug,
          title,
          // Order from the filename numeric prefix; fall back to discovery
          // index so unprefixed guides still sort deterministically.
          order: prefix !== null ? prefix : index,
          summary: firstParagraph(body),
          body,
          path: filePath,
        };
      } catch (err) {
        logger.warn(`[public.docs] failed to load ${filePath}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
};

/**
 * Name of the module whose guides ship as framework-provided demo content.
 * Every other module's guides are application-level — added by the downstream
 * consumer project (either a wholly new module, or extra guides dropped into
 * an existing module's `doc/guides/`). Framework guides ship exclusively
 * under `modules/home/doc/guides` today (see the two shipped samples); keying
 * precedence off that module — rather than adding a config flag — grounds the
 * distinction in data {@link loadGuideEntries} already produces (`entry.path`).
 * @type {string}
 */
const FRAMEWORK_GUIDE_MODULE = 'home';

/**
 * Precedence rank per tier — higher wins a cross-tier collision.
 * @type {{ framework: 0, application: 1 }}
 */
const PRECEDENCE_RANK = { framework: 0, application: 1 };

/**
 * Precedence tier for a guide entry on a slug collision.
 * @param {{ path: string }} entry - Guide entry (from {@link loadGuideEntries}).
 * @returns {'framework'|'application'} Precedence tier.
 */
const precedenceTier = (entry) => (moduleFromPath(entry.path) === FRAMEWORK_GUIDE_MODULE ? 'framework' : 'application');

/**
 * Resolve slug collisions across guide entries by precedence, producing the
 * single deduped list that feeds BOTH `buildDocsTree` and the service's slug
 * index — so the listing and the fetch endpoint can never disagree, and the
 * outcome no longer depends on file-scan order.
 *
 * Policy:
 *   1. **Cross-tier collision** — an application-level guide (any module other
 *      than {@link FRAMEWORK_GUIDE_MODULE}) always overrides a framework-provided
 *      one, regardless of scan order. This is the supported override mechanism
 *      for a consumer that ships its own `00-welcome`/`01-quickstart`; it is
 *      silent (debug-logged only), not an error.
 *   2. **Same-tier collision** (two framework guides, or two application
 *      guides) — precedence cannot disambiguate, so the kept guide is decided
 *      by {@link loadGuideEntries}'s existing deterministic sort (numeric
 *      prefix, then slug): the later entry in that order wins, same as before
 *      this fix. A warning is logged naming the actual policy, since neither
 *      guide "wins" by design.
 *
 * @param {ReturnType<typeof loadGuideEntries>} entries - Structured guides,
 *   already sorted by {@link loadGuideEntries}.
 * @returns {ReturnType<typeof loadGuideEntries>} Entries with slug collisions
 *   resolved — at most one entry per slug, original relative order preserved.
 */
const resolveGuideEntries = (entries) => {
  const list = Array.isArray(entries) ? entries : [];
  const winners = new Map(); // slug -> winning entry
  for (const entry of list) {
    const incumbent = winners.get(entry.slug);
    if (!incumbent) {
      winners.set(entry.slug, entry);
      continue;
    }
    const incumbentTier = precedenceTier(incumbent);
    const challengerTier = precedenceTier(entry);
    if (incumbentTier === challengerTier) {
      logger.warn(
        `[public/docs] duplicate guide slug "${entry.slug}" between two ${challengerTier} guides `
        + `("${incumbent.path}" vs "${entry.path}") — same precedence tier, so the kept guide is decided by file order, `
        + 'not policy; rename one guide, or move it to a module with different precedence (application overrides framework), to resolve deliberately.',
      );
      winners.set(entry.slug, entry); // later entry wins — existing deterministic tiebreak
      continue;
    }
    if (PRECEDENCE_RANK[challengerTier] > PRECEDENCE_RANK[incumbentTier]) {
      logger.debug(`[public/docs] guide slug "${entry.slug}" — application guide (${entry.path}) overrides framework guide (${incumbent.path})`);
      winners.set(entry.slug, entry);
    }
    // else: challenger is framework, incumbent is application — incumbent already wins.
  }
  return list.filter((entry) => winners.get(entry.slug) === entry);
};

/**
 * Slugify a label into a URL-safe category id.
 * @param {string} label - Human category label.
 * @returns {string} Lower-kebab id.
 */
const slugify = (label) => String(label)
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * Resolve the section a guide belongs to from the config grouping primitive.
 * A section matches when the guide's numeric prefix is within
 * `[prefixMin, prefixMax]`.
 * @param {{ slug: string, path: string, order: number }} entry - Guide entry.
 * @param {{ title: string, prefixMin: number, prefixMax: number, persona?: string[] }[]} sections
 * @returns {{ title: string, persona: string[] }|null} Matching section meta, or null.
 */
const sectionForEntry = (entry, sections) => {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const prefix = prefixFromPath(entry.path);
  if (prefix === null) return null;
  const match = sections.find((s) => prefix >= s.prefixMin && prefix <= s.prefixMax);
  if (!match) return null;
  return {
    title: match.title,
    persona: Array.isArray(match.persona) && match.persona.length > 0
      ? [...match.persona]
      : [...DEFAULT_PERSONA],
  };
};

/**
 * Build the public docs category tree from structured guide entries, grouped by
 * the config `guideSections` primitive.
 *
 * Grouping precedence per guide:
 *   1. the matching section from `config.docs.guideSections` (by prefix range);
 *   2. the capitalised module name fallback — guarantees every guide lands
 *      somewhere (never silently dropped).
 *
 * Category objects keep first-seen order; within a category guides preserve the
 * incoming (numeric-prefix) order. `id` is a slugified category key, `label` is
 * the human title (the section title, or the capitalised module name), `order`
 * is the lowest guide order within the category (stable category sort).
 *
 * @param {ReturnType<typeof loadGuideEntries>} entries - Structured guides.
 * @param {{ title: string, prefixMin: number, prefixMax: number, persona?: string[] }[]} [sections]
 *   The `config.docs.guideSections` grouping primitive.
 * @returns {{ categories: { id: string, label: string, order: number,
 *   guides: { slug: string, title: string, persona: string[], order: number, summary: string }[] }[] }}
 */
const buildDocsTree = (entries, sections = []) => {
  const list = Array.isArray(entries) ? entries : [];

  const categories = [];
  const byId = new Map();
  const pushTo = (label, guide) => {
    const id = slugify(label) || 'guides';
    let cat = byId.get(id);
    if (!cat) {
      cat = { id, label, order: guide.order, guides: [] };
      byId.set(id, cat);
      categories.push(cat);
    }
    cat.guides.push(guide);
    if (guide.order < cat.order) cat.order = guide.order;
  };

  for (const entry of list) {
    const section = sectionForEntry(entry, sections);
    // Precedence: config section → capitalised module name fallback.
    const label = section
      ? section.title
      : (() => {
        const mod = moduleFromPath(entry.path);
        return mod ? mod.charAt(0).toUpperCase() + mod.slice(1) : 'Guides';
      })();
    const persona = section ? section.persona : [...DEFAULT_PERSONA];
    pushTo(label, {
      slug: entry.slug,
      title: entry.title,
      persona,
      order: entry.order,
      summary: entry.summary,
    });
  }
  return { categories };
};

export default {
  DEFAULT_PERSONA,
  FRAMEWORK_GUIDE_MODULE,
  slugFromPath,
  prefixFromPath,
  moduleFromPath,
  titleFromMarkdown,
  stripLeadingH1,
  firstParagraph,
  loadGuideEntries,
  precedenceTier,
  resolveGuideEntries,
  buildDocsTree,
};
