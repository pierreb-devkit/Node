/**
 * Module dependencies.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import responses from '../responses.js';
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
