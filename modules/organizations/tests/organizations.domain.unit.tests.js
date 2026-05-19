/**
 * Unit tests for organizations.domain.js helper.
 */
import { describe, it, expect } from '@jest/globals';

import { normalizeEmailDomain, isPublicDomain } from '../services/organizations.domain.js';

describe('organizations.domain', () => {
  describe('normalizeEmailDomain', () => {
    it('lowercases and trims the domain part', () => {
      expect(normalizeEmailDomain('User@Sub.Example.COM ')).toBe('sub.example.com');
    });
    it('returns null for malformed input', () => {
      expect(normalizeEmailDomain('not-an-email')).toBeNull();
      expect(normalizeEmailDomain('')).toBeNull();
      expect(normalizeEmailDomain(null)).toBeNull();
    });
  });
  describe('isPublicDomain', () => {
    it('flags common public providers', () => {
      expect(isPublicDomain('gmail.com')).toBe(true);
      expect(isPublicDomain('outlook.com')).toBe(true);
    });
    it('does not flag a corporate domain', () => {
      expect(isPublicDomain('acme.com')).toBe(false);
    });
  });
});
