import path from 'path';

/**
 * Containment boundary for every mailer-resolved path (a template map entry,
 * `mailer.layout`, or a `mailer.partials.<name>` entry) — matches the
 * project root used by the original hardcoded `./config/templates/<name>.html`
 * read.
 */
export const PROJECT_ROOT = process.cwd();

/**
 * @desc Resolve a configured relative path to an absolute, in-root .html
 *   path, rejecting anything that escapes the project root.
 * @param {string} relativePath - The path as configured
 * @param {string} label - Identifies the offending config key in the thrown
 *   error, e.g. `mailer.templates["welcome"]` or `mailer.layout`
 * @returns {string} Absolute path to the file
 * @throws {Error} If the path is absolute, isn't .html, or escapes the
 *   project root
 */
export const resolveContainedPath = (relativePath, label) => {
  if (path.isAbsolute(relativePath) || path.extname(relativePath) !== '.html') {
    throw new Error(`${label} must be a relative path ending in .html`);
  }

  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const relativeToRoot = path.relative(PROJECT_ROOT, absolutePath);
  const escapesRoot =
    relativeToRoot === '' ||
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot);
  if (escapesRoot) {
    throw new Error(`${label} must resolve inside the project root`);
  }

  return absolutePath;
};

export default { PROJECT_ROOT, resolveContainedPath };
