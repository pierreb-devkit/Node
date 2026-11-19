/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';

import { encodeReferralCode, decodeReferralCode } from '../lib/users.referralCode.js';

/**
 * Unit tests — referralCode.js (#4212): the code is the user id encoded, derived not stored.
 */
describe('referralCode', () => {
  const id = '507f1f77bcf86cd799439011';

  test('round-trips an ObjectId through a 16-char url-safe code', () => {
    const code = encodeReferralCode(id);
    expect(code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(decodeReferralCode(code)).toBe(id);
  });

  test('encode rejects anything that is not an ObjectId hex', () => {
    expect(encodeReferralCode('nope')).toBeNull();
    expect(encodeReferralCode(undefined)).toBeNull();
  });

  test.each([undefined, null, 42, '', 'short', 'x'.repeat(17), 'bad chars here!!!', {}])('decode rejects %p', (bad) => {
    expect(decodeReferralCode(bad)).toBeNull();
  });

  test('every well-formed code round-trips (no padding bits, so one id has one code)', () => {
    for (const code of ['AAAAAAAAAAAAAAAA', 'zzzzzzzzzzzzzzzz', '-_-_-_-_-_-_-_-_']) {
      expect(encodeReferralCode(decodeReferralCode(code))).toBe(code);
    }
  });
});
