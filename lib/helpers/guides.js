/**
 * Markdown guide loader for the OpenAPI reference.
 *
 * Per-module markdown guides live under `modules/{name}/doc/guides/*.md`
 * and are discovered by the same globbing mechanism as OpenAPI YAML files
 * (see `config/assets.js` → `allGuides`).
 *
 * Guides are merged into the OpenAPI spec via `info.description`, which an
 * OpenAPI viewer renders as a top-level "Introduction" section, split on
 * markdown H1/H2 headings.
 *
 * When `mergeGuidesIntoSpec` is called with a `{ sections }` option, guides
 * are grouped under H1 section dividers (with each guide rendered as H2),
 * giving a sectioned IA structure instead of a flat list.
 */
import fs from 'fs';
import path from 'path';

import logger from '../services/logger.js';

/**
 * Derive a human-readable title from a guide file path.
 * E.g. `modules/auth/doc/guides/getting-started.md` → `Getting Started`
 *
 * A leading numeric ordering prefix (`NN-` or `NN_`, any digit count) is
 * stripped before title-casing so projects can control sidebar order via
 * filename prefixes (`00-welcome.md`, `01-api-access.md`, ...) without the
 * numbers leaking into the rendered titles. Filenames that are purely
 * numeric (`42.md`) fall back to the digits so we never emit an empty title.
 * @param {string} filePath - Absolute or relative path to the guide file.
 * @returns {string} Title-cased guide name.
 */
const titleFromPath = (filePath) => {
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const stripped = base.replace(/^\d+[-_]/, '');
  const source = stripped || base;
  return source
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Strip the first H1 heading from a markdown body (if present).
 * The loader injects its own H1 based on the file name so Redoc's sidebar
 * stays consistent even when guides omit a title or use a different one.
 * @param {string} markdown - Raw markdown content.
 * @returns {string} Markdown without the leading H1.
 */
const stripLeadingH1 = (markdown) => String(markdown).replace(/^\s*#\s+[^\n]*\n+/, '');

/**
 * Load markdown guides from disk and return normalized entries.
 * Invalid/unreadable files are skipped with a warning so one broken guide
 * cannot take down the whole API reference.
 * @param {string[]} filePaths - Absolute paths to `.md` guide files.
 * @returns {{ title: string, body: string, path: string }[]} Loaded guides.
 */
const loadGuides = (filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  return filePaths
    .map((filePath) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const body = stripLeadingH1(raw).trim();
        if (!body) {
          logger.warn(`[guides] skipping ${filePath}: empty markdown content`);
          return null;
        }
        return { title: titleFromPath(filePath), body, path: filePath };
      } catch (err) {
        logger.warn(`[guides] failed to load ${filePath}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    // Stable alphabetical order so the sidebar is deterministic across
    // filesystems (glob order varies on macOS vs Linux containers). Sort on
    // the raw basename rather than the rendered title so numeric ordering
    // prefixes (`00-welcome.md`, `01-api-access.md`) still control order
    // even though the digits are stripped from the visible title.
    .sort((a, b) => {
      const keyA = path.basename(String(a.path), path.extname(String(a.path)));
      const keyB = path.basename(String(b.path), path.extname(String(b.path)));
      return keyA.localeCompare(keyB);
    });
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
 * Merge loaded guides into an OpenAPI spec's `info.description`.
 *
 * **Flat mode (default)** — each guide becomes a top-level H1 section.
 * An OpenAPI viewer renders each H1 as a sidebar entry.
 *
 * **Sectioned mode** — when `options.sections` is provided, guides are
 * grouped under H1 dividers (one per section) with each guide rendered as
 * H2, giving a compact sectioned IA instead of a flat list.
 * Guides whose filename prefix does not fall in any section range are
 * appended at the end as H2 (never silently dropped).
 *
 * The original spec is mutated (and returned) to match the merge style used
 * by `initApiSpec` in `lib/services/express.js`.
 *
 * @param {object} spec - OpenAPI spec object (will be mutated).
 * @param {{ title: string, body: string, path?: string }[]} guides - Loaded guide entries.
 *   `path` is only required when using sectioned mode (needed for prefix extraction).
 * @param {{ sections?: { title: string, prefixMin: number, prefixMax: number }[] } | null} [options]
 * @returns {object|*} The mutated spec (or the original value when `spec` is falsy / not an object).
 */
const mergeGuidesIntoSpec = (spec, guides, options = {}) => {
  if (!spec || typeof spec !== 'object') return spec;
  if (!Array.isArray(guides) || guides.length === 0) return spec;

  const { sections } = (options != null ? options : {});
  let sectionsBlock;

  if (Array.isArray(sections) && sections.length > 0) {
    // Sectioned mode: group by filename numeric prefix
    const groups = sections.map((sec) => ({ ...sec, guides: [] }));
    const orphans = [];
    for (const guide of guides) {
      const prefix = prefixFromPath(guide.path);
      const group = prefix !== null
        ? groups.find((g) => prefix >= g.prefixMin && prefix <= g.prefixMax)
        : null;
      if (group) group.guides.push(guide);
      else orphans.push(guide);
    }
    const sectionMarkdown = groups
      .filter((g) => g.guides.length > 0)
      .map((g) => {
        const guideBlocks = g.guides.map(({ title, body }) => `## ${title}\n\n${body}`).join('\n\n');
        return `# ${g.title}\n\n${guideBlocks}`;
      });
    const orphanBlocks = orphans.map(({ title, body }) => `## ${title}\n\n${body}`);
    sectionsBlock = [...sectionMarkdown, ...orphanBlocks].join('\n\n');
  } else {
    // Flat mode (backward-compat): one H1 per guide
    sectionsBlock = guides.map(({ title, body }) => `# ${title}\n\n${body}`).join('\n\n');
  }

  const existing = typeof spec.info?.description === 'string' ? spec.info.description.trim() : '';
  const merged = [existing, sectionsBlock].filter(Boolean).join('\n\n');

  spec.info = { ...(spec.info || {}), description: merged };
  return spec;
};

export default {
  titleFromPath,
  stripLeadingH1,
  loadGuides,
  mergeGuidesIntoSpec,
  prefixFromPath,
};
