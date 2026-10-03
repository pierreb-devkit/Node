import config from '../../../config/index.js';
import { resolveContainedPath } from './paths.js';

// Devkit owns every `config/templates/_*` folder (epic #4127); this is the
// shared layout's own namespace. `config/templates/<project>/` belongs to a
// downstream instead.
const DEFAULT_LAYOUT_PATH = 'config/templates/_layout/layout.html';
const DEFAULT_PARTIAL_PATHS = {
  header: 'config/templates/_layout/header.html',
  footer: 'config/templates/_layout/footer.html',
  button: 'config/templates/_layout/button.html',
  styles: 'config/templates/_layout/styles.html',
};

export const PARTIAL_NAMES = Object.keys(DEFAULT_PARTIAL_PATHS);

// A template whose trimmed source starts with `<!doctype` or `<html`
// (case-insensitive) is a legacy full document.
const LEGACY_FULL_DOCUMENT_RE = /^\s*<(!doctype|html)\b/i;

/**
 * @desc Detect a legacy full-document template (a downstream's own full
 *   document, e.g. its own branded email a project ships outside Devkit's
 *   `config/templates/`): it is already a complete HTML document, so it is
 *   sent unwrapped instead of through the layout. The 15 shared Devkit
 *   mails (#4133) are body fragments and never match this.
 * @param {string} source - Raw (uncompiled) template source
 * @returns {boolean} True when the source is a full document
 */
export const isLegacyFullDocument = (source) => LEGACY_FULL_DOCUMENT_RE.test(source);

/**
 * @desc Resolve `mailer.layout` (or the Devkit default) to an absolute,
 *   in-root .html path. `||`, not `??`: an explicitly-empty configured
 *   value (e.g. an unset env var resolving to `''`) falls back too, instead
 *   of failing containment on every mail.
 * @returns {string} Absolute path to the layout file
 * @throws {Error} If the configured path escapes the project root, isn't
 *   relative, or isn't .html — the error names `mailer.layout`
 */
export const resolveLayoutPath = () => resolveContainedPath(config.mailer?.layout || DEFAULT_LAYOUT_PATH, 'mailer.layout');

/**
 * @desc Resolve one `mailer.partials.<name>` entry (or its Devkit default)
 *   to an absolute, in-root .html path. `name` is always one of
 *   `PARTIAL_NAMES` (header, footer, button, styles) — never caller/user
 *   input, so it is not sanitized the way a template key is.
 * @param {string} name - One of `PARTIAL_NAMES`
 * @returns {string} Absolute path to the partial file
 * @throws {Error} If the configured path escapes the project root, isn't
 *   relative, or isn't .html — the error names `mailer.partials["<name>"]`
 */
export const resolvePartialPath = (name) => resolveContainedPath(config.mailer?.partials?.[name] || DEFAULT_PARTIAL_PATHS[name], `mailer.partials["${name}"]`);
