/**
 * Module dependencies.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import responses, { buildWhitelist, pickWhitelistedDetails } from '../responses.js';
import AppError from '../AppError.js';

/**
 * Build a minimal Express response double that captures status + json body.
 * @returns {{status: Function, json: Function, _status: number, _body: object}}
 */
const buildRes = () => {
  const res = {
    _status: undefined,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
};

/**
 * Unit tests — production-safe whitelisted `AppError.details` keys must cross
 * into the error envelope in EVERY environment, while everything else stays
 * dev-only exactly as before (issue #3958). Whitelist is opt-in by exact key
 * name (`upgradeUrl`, `type`, `retryAfter`) — a key not on that list is
 * dropped, never passed through by shape or naming convention.
 */
describe('responses.error — whitelisted details gating:', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a whitelisted key (upgradeUrl) passes through in production mode', () => {
    process.env.NODE_ENV = 'production';
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: { type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' },
    });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' });
    // Still no raw-error leak alongside it.
    expect(res._body.error).toBeUndefined();
  });

  test('a whitelisted key passes through under any non-dev NODE_ENV label, not just the literal "production"', () => {
    process.env.NODE_ENV = 'someproject';
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: { upgradeUrl: '/billing/plans' } });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ upgradeUrl: '/billing/plans' });
  });

  test('a NON-whitelisted key is stripped in production mode', () => {
    process.env.NODE_ENV = 'production';
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: { upgradeUrl: '/billing/plans', internalAccountId: 'acct_super_secret' },
    });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ upgradeUrl: '/billing/plans' });
    expect(res._body.details.internalAccountId).toBeUndefined();
  });

  test('details with ONLY non-whitelisted keys adds no `details` field at all, in production', () => {
    process.env.NODE_ENV = 'production';
    const res = buildRes();
    const err = new AppError('Repository failure', {
      status: 500,
      details: { internalStack: 'at Object.<anonymous> (/app/lib.js:12:5)' },
    });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('a validation-style array `details` (the AppError default shape) adds no `details` field, in production', () => {
    process.env.NODE_ENV = 'production';
    const res = buildRes();
    // No `details` passed → AppError defaults to `[{ message }]`.
    const err = new AppError('Something went wrong.');
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('dev/test behavior is unchanged: full raw details still serialize via the existing dev-only blob', () => {
    process.env.NODE_ENV = 'development';
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: { type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans', meterUsed: 5000, meterQuota: 5000 },
    });
    responses.error(res, 402)(err);
    // Full details (including non-whitelisted meterUsed/meterQuota) still reach
    // the client via the pre-existing dev-only serialized-error blob.
    expect(typeof res._body.error).toBe('string');
    expect(res._body.error).toContain('meterUsed');
    expect(res._body.error).toContain('meterQuota');
    // AND the whitelisted subset is present at the top level too (uniform shape
    // across environments — a client never has to special-case dev).
    expect(res._body.details).toEqual({ type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' });
  });

  test('dev/test behavior is unchanged: a non-whitelisted-only details object still shows up in the dev blob', () => {
    process.env.NODE_ENV = 'test';
    const res = buildRes();
    const err = new AppError('Repository failure', { status: 500, details: { internalStack: 'trace here' } });
    responses.error(res, 500)(err);
    expect(res._body.error).toContain('internalStack');
    expect(res._body.details).toBeUndefined();
  });
});

/**
 * Unit tests — a whitelisted KEY match is not enough: the VALUE at that key
 * must also be a safe scalar (issue #3958 review finding 1). Several
 * pre-existing call sites across the stack hand this a raw caught exception
 * (`details: err` / `details: err.details || err`), so any future error
 * shape exposing an own `type`/`upgradeUrl`/`retryAfter` property must not
 * leak its full value just because the key matched.
 */
describe('responses.error — whitelisted details value validation (finding 1):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a nested object under a whitelisted key is dropped, not serialized into the production response', () => {
    const res = buildRes();
    const err = new AppError('boom', {
      status: 500,
      details: { type: { dbHost: 'internal-db.local', secret: 'internal-only' } },
    });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('a nested object under upgradeUrl is dropped too', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { upgradeUrl: { dbHost: 'internal-db.local' } } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('an unsafe (object) value at one whitelisted key is dropped while a safe sibling key is kept', () => {
    const res = buildRes();
    const err = new AppError('boom', {
      status: 402,
      details: { type: 'METER_EXHAUSTED', upgradeUrl: { nested: true } },
    });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ type: 'METER_EXHAUSTED' });
  });

  test('an array value at a whitelisted key is dropped', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { type: ['a', 'b'] } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('a function value at a whitelisted key is dropped', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { type() {} } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('an explicit undefined value at a whitelisted key is dropped', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { type: undefined } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('a non-finite number (NaN/Infinity) value at a whitelisted key is dropped', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { retryAfter: Infinity } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('a whitelisted string value longer than the safe length cap is dropped', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { type: 'x'.repeat(201) } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });

  test('safe scalars (finite number, boolean, string within the cap, null) are all kept', () => {
    const res = buildRes();
    const err = new AppError('boom', {
      status: 402,
      details: { retryAfter: 30, upgradeUrl: '/billing/plans', type: null },
    });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ retryAfter: 30, upgradeUrl: '/billing/plans', type: null });
  });

  test('a case-variant key (TYPE, UpgradeUrl) is not matched — exact key name only', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { TYPE: 'x', UpgradeUrl: '/y' } });
    responses.error(res, 500)(err);
    expect(res._body.details).toBeUndefined();
  });
});

/**
 * Unit tests — a throwing getter must never crash the picker (post-#3958
 * follow-up review, finding 1). `AppError.details` is populated with a raw
 * caught exception at several call sites; a value backed by a getter that
 * throws must be treated the same as any other unsafe shape — dropped,
 * never propagated — and must not stop the loop from picking the remaining
 * whitelisted keys.
 */
describe('pickWhitelistedDetails — a throwing getter is dropped, not propagated (follow-up finding 1):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a throwing getter on the FIRST whitelisted key does not prevent LATER whitelisted keys from being picked, and the response still carries the intended status/message', () => {
    const res = buildRes();
    const details = { type: 'METER_EXHAUSTED', retryAfter: 30 };
    Object.defineProperty(details, 'upgradeUrl', {
      enumerable: true,
      get() {
        throw new Error('boom from a getter');
      },
    });
    const err = new AppError('Meter exhausted', { status: 402, details });
    expect(() => responses.error(res, 402)(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.message).toBe('Meter exhausted');
    expect(res._body.details).toEqual({ type: 'METER_EXHAUSTED', retryAfter: 30 });
    expect(res._body.details.upgradeUrl).toBeUndefined();
  });

  test('a throwing getter on a MIDDLE whitelisted key does not partially populate — every other whitelisted key is still present', () => {
    const res = buildRes();
    const details = { upgradeUrl: '/billing/plans', retryAfter: 30 };
    Object.defineProperty(details, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom from a getter');
      },
    });
    const err = new AppError('Meter exhausted', { status: 402, details });
    expect(() => responses.error(res, 402)(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.details).toEqual({ upgradeUrl: '/billing/plans', retryAfter: 30 });
  });

  test('pickWhitelistedDetails called directly with a throwing getter never throws and drops only the throwing key', () => {
    const details = { retryAfter: 30 };
    Object.defineProperty(details, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom from a getter');
      },
    });
    let picked;
    expect(() => {
      picked = pickWhitelistedDetails(details);
    }).not.toThrow();
    expect(picked).toEqual({ retryAfter: 30 });
  });
});

/**
 * Unit tests — `buildWhitelist` (issue #3958 review findings 2 & 3): the
 * config-provided extension to the built-in whitelist must reject
 * prototype-polluting key names and filter non-string/empty elements, per
 * element, not just reject a malformed whole value.
 */
describe('buildWhitelist — config-provided whitelist extension sanitation (findings 2 & 3):', () => {
  const BUILT_INS = ['upgradeUrl', 'type', 'retryAfter'];

  test('rejects __proto__ from the config extension', () => {
    const whitelist = buildWhitelist(['__proto__']);
    expect(whitelist.has('__proto__')).toBe(false);
    expect([...whitelist].sort()).toEqual([...BUILT_INS].sort());
  });

  test('rejects constructor and prototype from the config extension', () => {
    const whitelist = buildWhitelist(['constructor', 'prototype']);
    expect(whitelist.has('constructor')).toBe(false);
    expect(whitelist.has('prototype')).toBe(false);
  });

  test('keeps a legitimate downstream key alongside a rejected unsafe one', () => {
    const whitelist = buildWhitelist(['__proto__', 'aDownstreamSafeKey']);
    expect(whitelist.has('aDownstreamSafeKey')).toBe(true);
    expect(whitelist.has('__proto__')).toBe(false);
  });

  test('filters non-string and empty-string elements, keeping valid string elements', () => {
    const whitelist = buildWhitelist(['aKey', 123, {}, null, '', 'anotherKey']);
    const extras = [...whitelist].filter((key) => !BUILT_INS.includes(key));
    expect(extras.sort()).toEqual(['aKey', 'anotherKey']);
  });

  test('a malformed (non-array) config value degrades to exactly the built-in defaults', () => {
    expect([...buildWhitelist('not-an-array')].sort()).toEqual([...BUILT_INS].sort());
    expect([...buildWhitelist({})].sort()).toEqual([...BUILT_INS].sort());
    expect([...buildWhitelist(null)].sort()).toEqual([...BUILT_INS].sort());
    expect([...buildWhitelist(undefined)].sort()).toEqual([...BUILT_INS].sort());
  });
});

/**
 * Unit tests — belt-and-braces null-prototype defense in
 * `pickWhitelistedDetails` (issue #3958 review finding 2), isolated from the
 * OTHER two defenses (the config-side `UNSAFE_KEYS` guard, and finding 1's
 * scalar-value guard) so this specific mechanism is not decoration: an
 * object-shaped `__proto__` value is already intercepted by finding 1's
 * value guard before it would ever reach this code path, so that shape
 * cannot exercise this test in isolation — a scalar value is used instead,
 * matching what `isSafeDetailValue` accepts, to reach the assignment itself.
 */
describe('pickWhitelistedDetails — null-prototype belt-and-braces (finding 2):', () => {
  test('the returned object always has a null prototype, for an ordinary safe pick', () => {
    const picked = pickWhitelistedDetails({ upgradeUrl: '/billing/plans' });
    expect(Object.getPrototypeOf(picked)).toBeNull();
  });

  test('a details object with a real own "__proto__" property (safe scalar value), matched by the whitelist, is stored as a data property without reassigning the picked object prototype', () => {
    // Object.defineProperty (like JSON.parse would for `{"__proto__": "x"}`)
    // creates a genuine OWN property named "__proto__" — unlike the
    // `{ __proto__: x }` object-literal syntax, which the spec special-cases
    // to set the prototype directly instead of creating an own property.
    const maliciousDetails = Object.defineProperty({}, '__proto__', {
      value: 'not-an-object-marker',
      enumerable: true,
    });
    const picked = pickWhitelistedDetails(maliciousDetails, new Set(['__proto__']));
    expect(Object.getPrototypeOf(picked)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(picked, '__proto__')).toBe(true);
    expect(picked.__proto__).toBe('not-an-object-marker');
  });
});
