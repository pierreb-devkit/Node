/**
 * Unit tests for isJwtSecretWeak in config helper.
 *
 * Verifies that the exported helper returns the same verdicts as the two
 * former private predicates it replaces (validateJwtSecret + jwtInsecure in
 * home.service.js).  Zero behavior change is the acceptance criterion.
 *
 * Weak cases (returns true):
 *  - undefined / null / empty string / whitespace-only
 *  - length < 32 characters
 *  - each known default placeholder
 *
 * Strong case (returns false):
 *  - a ≥ 32-char string that is not in the defaults list
 */
import { describe, test, expect } from '@jest/globals';
import configHelper from '../config.js';

const { isJwtSecretWeak, JWT_DEFAULT_SECRETS } = configHelper;

const STRONG_SECRET = 'a'.repeat(32); // exactly 32 chars, non-default

describe('config.isJwtSecretWeak', () => {
  // ---- weak: empty / missing ------------------------------------------------

  test('undefined → true (weak)', () => {
    expect(isJwtSecretWeak(undefined)).toBe(true);
  });

  test('null → true (weak)', () => {
    expect(isJwtSecretWeak(null)).toBe(true);
  });

  test('empty string → true (weak)', () => {
    expect(isJwtSecretWeak('')).toBe(true);
  });

  test('whitespace-only string → true (weak)', () => {
    expect(isJwtSecretWeak('   ')).toBe(true);
  });

  // ---- weak: too short ------------------------------------------------------

  test('short secret (< 32 chars, not a known default) → true (weak)', () => {
    expect(isJwtSecretWeak('tooshort')).toBe(true);
  });

  test('31-char secret → true (weak)', () => {
    expect(isJwtSecretWeak('a'.repeat(31))).toBe(true);
  });

  // ---- weak: each known default placeholder ---------------------------------

  test('upstream placeholder → true (weak)', () => {
    expect(isJwtSecretWeak('WaosSecretKeyExampleToChnageAbsolutely')).toBe(true);
  });

  test('ExampleNodeDevSecret → true (weak)', () => {
    expect(isJwtSecretWeak('ExampleNodeDevSecret')).toBe(true);
  });

  test('ChangeThisDevSecret → true (weak)', () => {
    expect(isJwtSecretWeak('ChangeThisDevSecret')).toBe(true);
  });

  // covers the full JWT_DEFAULT_SECRETS set exhaustively
  test('all entries in JWT_DEFAULT_SECRETS → true (weak)', () => {
    for (const s of JWT_DEFAULT_SECRETS) {
      expect(isJwtSecretWeak(s)).toBe(true);
    }
  });

  // ---- strong ---------------------------------------------------------------

  test('32-char non-default secret → false (strong)', () => {
    expect(isJwtSecretWeak(STRONG_SECRET)).toBe(false);
  });

  test('long strong secret → false (strong)', () => {
    expect(isJwtSecretWeak('supersecret_random_string_at_least_32_chars!')).toBe(false);
  });
});
