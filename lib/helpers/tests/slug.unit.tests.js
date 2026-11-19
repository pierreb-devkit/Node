/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

import { slugify, uniqueSlug } from '../slug.js';

describe('slug helper unit tests:', () => {
  test('slugify strips accents, hyphenates and lowercases', () => {
    expect(slugify('  Élodie\'s  Café & Co!  ')).toBe('elodie-s-cafe-co');
  });

  test('uniqueSlug returns the base when it is free', async () => {
    const exists = jest.fn().mockResolvedValue(null);
    await expect(uniqueSlug('acme', exists)).resolves.toBe('acme');
    expect(exists).toHaveBeenCalledWith('acme');
  });

  test('uniqueSlug numbers the base until a free slug is found', async () => {
    const taken = new Set(['acme', 'acme-1']);
    await expect(uniqueSlug('acme', async (slug) => taken.has(slug))).resolves.toBe('acme-2');
  });

  test('uniqueSlug tries the requested first candidate before the numbered base', async () => {
    const taken = new Set(['wanted']);
    await expect(uniqueSlug('acme', async (slug) => taken.has(slug), 'wanted')).resolves.toBe('acme-1');
    await expect(uniqueSlug('acme', async () => false, 'wanted')).resolves.toBe('wanted');
  });
});
