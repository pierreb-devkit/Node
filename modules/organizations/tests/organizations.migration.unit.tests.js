/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

// Ensure models are registered before tests
import '../models/organizations.model.mongoose.js';
import '../models/organizations.membership.model.mongoose.js';

import { slugify, generateOrganizationSlug } from '../helpers/slug.js';

/**
 * Unit tests for the organization migration helpers
 */
describe('Organizations migration unit tests:', () => {
  describe('slugify', () => {
    it('should lowercase and hyphenate a simple name', () => {
      expect(slugify('Pierre Brisorgueil')).toBe('pierre-brisorgueil');
    });

    it('should strip diacritics / accented characters', () => {
      expect(slugify('Ren\u00e9')).toBe('rene');
      expect(slugify('H\u00e9l\u00e8ne')).toBe('helene');
    });

    it('should replace multiple non-alphanumeric chars with a single hyphen', () => {
      expect(slugify('hello   world!!!')).toBe('hello-world');
    });

    it('should strip leading and trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('should handle unicode special characters', () => {
      expect(slugify('caf\u00e9')).toBe('cafe');
    });
  });

  describe('generateOrganizationSlug', () => {
    it('should generate a slug from firstName', async () => {
      // Mock Organization.exists to always return false (no duplicates)
      const Organization = mongoose.model('Organization');
      const existsSpy = jest.spyOn(Organization, 'exists').mockResolvedValue(false);

      const slug = await generateOrganizationSlug('Pierre', 'Brisorgueil');
      expect(slug).toBe('pierres-organization');

      existsSpy.mockRestore();
    });

    it('should fall back to lastName when firstName is empty', async () => {
      const Organization = mongoose.model('Organization');
      const existsSpy = jest.spyOn(Organization, 'exists').mockResolvedValue(false);

      const slug = await generateOrganizationSlug('', 'Brisorgueil');
      expect(slug).toBe('brisorgueils-organization');

      existsSpy.mockRestore();
    });

    it('should append a numeric suffix when slug already exists', async () => {
      const Organization = mongoose.model('Organization');
      const existsSpy = jest
        .spyOn(Organization, 'exists')
        .mockResolvedValueOnce(true) // first candidate exists
        .mockResolvedValueOnce(true) // -1 exists
        .mockResolvedValueOnce(false); // -2 is free

      const slug = await generateOrganizationSlug('Pierre', 'B');
      expect(slug).toBe('pierres-organization-2');

      existsSpy.mockRestore();
    });
  });
});
