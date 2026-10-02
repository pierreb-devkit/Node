import fs from 'fs';
import path from 'path';

/**
 * Containment boundary for every mailer-resolved path (a template map entry,
 * `mailer.layout`, or a `mailer.partials.<name>` entry) — matches the
 * project root used by the original hardcoded `./config/templates/<name>.html`
 * read.
 */
const PROJECT_ROOT = process.cwd();

/**
 * @desc True when `target` (already absolute) is outside `root` (already
 *   absolute) — shared by the syntactic check below and the post-symlink
 *   canonical recheck, so both apply the exact same boundary rule.
 * @param {string} root - Absolute containing directory
 * @param {string} target - Absolute path to check
 * @returns {boolean} True if `target` is `root` itself or falls outside it
 */
const isOutside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

/**
 * @desc Resolve a configured relative path to an absolute, in-root .html
 *   path, rejecting anything that escapes the project root. A path that
 *   exists on disk is also canonicalized (symlinks resolved) and rechecked,
 *   so a symlink planted inside the root but pointing outside it is caught
 *   too — a path that doesn't exist yet has nothing to canonicalize and
 *   keeps the syntactic check's result.
 * @param {string} relativePath - The path as configured
 * @param {string} label - Identifies the offending config key in the thrown
 *   error, e.g. `mailer.templates["welcome"]` or `mailer.layout`
 * @returns {string} Absolute path to the file — the canonical (symlink-
 *   resolved) path when the target exists, else the plain resolved path
 * @throws {Error} If the path is absolute, isn't .html, or escapes the
 *   project root (syntactically or, for an existing file, via a symlink)
 */
export const resolveContainedPath = (relativePath, label) => {
  if (path.isAbsolute(relativePath) || path.extname(relativePath) !== '.html') {
    throw new Error(`${label} must be a relative path ending in .html`);
  }

  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  if (isOutside(PROJECT_ROOT, absolutePath)) {
    throw new Error(`${label} must resolve inside the project root`);
  }

  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync(absolutePath);
  } catch (err) {
    if (err.code === 'ENOENT') return absolutePath;
    throw err;
  }

  if (isOutside(fs.realpathSync(PROJECT_ROOT), canonicalPath)) {
    throw new Error(`${label} must resolve inside the project root`);
  }

  return canonicalPath;
};
