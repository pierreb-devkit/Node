/**
 * Unit tests for validateJwtSecret in config helper.
 *
 * Behaviour matrix:
 *  - prod env  + empty secret          → throws
 *  - prod env  + short secret (<32)    → throws
 *  - prod env  + upstream placeholder  → throws
 *  - prod env  + generic placeholder   → throws
 *  - prod env  + strong secret (≥32)   → no throw, no warn
 *  - dev  env  + default secret        → console.log warn, no throw
 *  - test env  + default secret        → console.log warn, no throw
 *  - local env + default secret        → console.log warn, no throw
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// We import the module directly (no mocking needed — pure utility).
import configHelper from '../config.js';

const { validateJwtSecret } = configHelper;

const STRONG_SECRET = 'a'.repeat(32); // exactly 32 chars, non-default
const UPSTREAM_PLACEHOLDER = 'WaosSecretKeyExampleToChnageAbsolutely';
const GENERIC_PLACEHOLDER = 'ExampleNodeDevSecret'; // known generic placeholder (< 32 chars too)
const SHORT_SECRET = 'tooshort'; // < 32 chars, not a known default

describe('config.validateJwtSecret', () => {
  let consoleLogSpy;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  // ---- prod: fail-closed ------------------------------------------------

  test('prod + undefined secret → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: undefined } })).toThrow();
  });

  test('prod + empty string secret → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: '' } })).toThrow();
  });

  test('prod + whitespace-only secret → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: '   ' } })).toThrow();
  });

  test('prod + short secret (< 32 chars) → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: SHORT_SECRET } })).toThrow();
  });

  test('prod + upstream placeholder → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: UPSTREAM_PLACEHOLDER } })).toThrow();
  });

  test('prod + generic placeholder (ExampleNodeDevSecret) → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: GENERIC_PLACEHOLDER } })).toThrow();
  });

  test('prod + no jwt key at all → throws', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({})).toThrow();
  });

  test('prod + strong secret (≥32 chars, non-default) → no throw, no warn', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateJwtSecret({ jwt: { secret: STRONG_SECRET } })).not.toThrow();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  // ---- staging / other non-dev: also fail-closed -----------------------

  test('staging env + short secret → throws', () => {
    process.env.NODE_ENV = 'staging';
    expect(() => validateJwtSecret({ jwt: { secret: SHORT_SECRET } })).toThrow();
  });

  // ---- dev/test/local: warn, never throw --------------------------------

  test('dev env + upstream placeholder → warns (console.log), no throw', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateJwtSecret({ jwt: { secret: UPSTREAM_PLACEHOLDER } })).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('dev env + empty secret → warns (console.log), no throw', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateJwtSecret({ jwt: { secret: '' } })).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('dev env + short secret → warns (console.log), no throw', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateJwtSecret({ jwt: { secret: SHORT_SECRET } })).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('test env + upstream placeholder → warns (console.log), no throw', () => {
    process.env.NODE_ENV = 'test';
    expect(() => validateJwtSecret({ jwt: { secret: UPSTREAM_PLACEHOLDER } })).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('local env + upstream placeholder → warns (console.log), no throw', () => {
    process.env.NODE_ENV = 'local';
    expect(() => validateJwtSecret({ jwt: { secret: UPSTREAM_PLACEHOLDER } })).not.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('dev env + strong secret → no throw, no warn', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateJwtSecret({ jwt: { secret: STRONG_SECRET } })).not.toThrow();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
