import { describe, test, expect } from '@jest/globals';
import errors from '../errors.js';

/**
 * getUniqueMessage (via errors.getMessage on an E11000) must derive the friendly
 * "X already exists." message from the driver keyPattern — index-NAME-agnostic — so
 * it survives the E3 rename of the email unique index from `email_1` to the
 * collation-named `email_ci_unique`.
 */
describe('errors.getMessage — E11000 unique violation (keyPattern, index-name agnostic)', () => {
  test('derives the field from keyPattern for the collation email index (no _1 suffix)', () => {
    const err = {
      code: 11000,
      keyPattern: { email: 1 },
      // collation index name + a binary-garbled key value (real-world shape)
      errmsg: 'E11000 duplicate key error collection: db.users index: email_ci_unique collation: { locale: "en" } dup key: { email: "??" }',
    };
    expect(errors.getMessage(err)).toBe('Email already exists.');
  });

  test('still works via keyPattern for a legacy email_1 index', () => {
    const err = {
      code: 11000,
      keyPattern: { email: 1 },
      errmsg: 'E11000 duplicate key error collection: db.users index: email_1 dup key: { : "a@b.co" }',
    };
    expect(errors.getMessage(err)).toBe('Email already exists.');
  });

  test('falls back to the legacy errmsg parse when keyPattern is absent (older drivers)', () => {
    const err = {
      code: 11000,
      errmsg: 'E11000 duplicate key error collection: db.users index: email_1 dup key: { : "a@b.co" }',
    };
    expect(errors.getMessage(err)).toBe('Email already exists.');
  });
});
