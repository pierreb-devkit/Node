/**
 * @desc Normalize a string into a URL-safe slug: strips diacritics, replaces
 *   non-alphanumeric runs with hyphens, trims hyphens and lowercases.
 * @param {string} input - The raw string to slugify.
 * @returns {string} The normalized slug.
 */
const slugify = (input) =>
  input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * @desc Find a free slug: try `first`, then `${base}-1`, `${base}-2`, … until
 *   `exists` answers falsy.
 * @param {string} base - The slug the numbered candidates are built on.
 * @param {(slug: string) => Promise<unknown>} exists - Whether a slug is taken.
 * @param {string} [first=base] - The first candidate (e.g. a slug the caller asked for).
 * @returns {Promise<string>} A slug `exists` reports as free.
 */
const uniqueSlug = async (base, exists, first = base) => {
  let candidate = first;
  let counter = 1;
  while (await exists(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
};

export { slugify, uniqueSlug };
export default { slugify, uniqueSlug };
