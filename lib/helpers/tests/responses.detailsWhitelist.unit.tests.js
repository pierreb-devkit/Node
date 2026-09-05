/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
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

  // Boundary asserted on BOTH sides (finding 5, 2026-09 review round): only
  // the over-cap (201) side was previously tested, so a `<=` -> `<` mutation
  // of the length check survived the whole suite — it would silently drop a
  // real 200-char `upgradeUrl` in production. Asserting exactly-200-is-kept
  // alongside the existing 201-is-dropped test pins both sides of the cap.
  test('a whitelisted string value of EXACTLY the safe length cap (200 chars) is kept', () => {
    const res = buildRes();
    const err = new AppError('boom', { status: 402, details: { type: 'x'.repeat(200) } });
    responses.error(res, 402)(err);
    expect(res._body.details).toEqual({ type: 'x'.repeat(200) });
  });

  // Actual boolean value used (finding 6, 2026-09 review round): the
  // fixture previously named "boolean" in this test's title never included
  // one (`type: null` covered null, not boolean), so deleting the
  // `typeof value === 'boolean'` branch of `isSafeDetailValue` survived the
  // whole suite. `pickWhitelistedDetails` is called directly with an
  // explicit 4-key whitelist so all four safe-scalar kinds the title claims
  // (finite number, boolean, string within the cap, null) can be exercised
  // in one fixture despite the module's default whitelist having only 3 keys.
  test('safe scalars (finite number, boolean, string within the cap, null) are all kept', () => {
    const picked = pickWhitelistedDetails(
      { retryAfter: 30, isRetryable: true, upgradeUrl: '/billing/plans', type: null },
      new Set(['retryAfter', 'isRetryable', 'upgradeUrl', 'type']),
    );
    expect(picked).toEqual({ retryAfter: 30, isRetryable: true, upgradeUrl: '/billing/plans', type: null });
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

  // Finding 3 (2026-09 review round): the OWNERSHIP CHECK itself, not just
  // the value read after it, must be inside the protected region. A `details`
  // that is a hostile Proxy whose `getOwnPropertyDescriptor` trap throws
  // makes `Object.prototype.hasOwnProperty.call(details, key)` throw (that
  // call invokes the trap) — a shape the round-2 fix above did not cover,
  // since its try/catch started AFTER the ownership check.
  test('a `details` Proxy whose getOwnPropertyDescriptor trap throws does not crash the response — status/message still sent', () => {
    const res = buildRes();
    const hostileDetails = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap boom');
        },
      },
    );
    const err = new AppError('Meter exhausted', { status: 402, details: hostileDetails });
    expect(() => responses.error(res, 402, 'Meter exhausted')(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.message).toBe('Meter exhausted');
    expect(res._body.details).toBeUndefined();
  });

  test('pickWhitelistedDetails called directly with a getOwnPropertyDescriptor-throwing Proxy never throws', () => {
    const hostileDetails = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap boom');
        },
      },
    );
    let picked;
    expect(() => {
      picked = pickWhitelistedDetails(hostileDetails);
    }).not.toThrow();
    expect(picked).toBeUndefined();
  });
});

/**
 * Unit tests — `error.details` is read at the `responses.error` call site
 * ONE FRAME ABOVE `pickWhitelistedDetails` (finding 4, 2026-09 review round).
 * A throwing `details` accessor on the error object itself (not merely on a
 * property nested inside `details`) crashes that read before it ever reaches
 * the picker's own try/catch, losing the request's real status/message to
 * whatever generic handler catches the escaped exception. An explicit
 * `description` argument is passed here so this test isolates the exact
 * `rawDetails = error.details` read this fix protects — the separate
 * `getDescription` re-read is now ALSO guarded (finding-4 follow-up below).
 */
describe('responses.error — a throwing `details` accessor on the error object itself does not crash the response (finding 4):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('an AppError whose `details` getter throws does not crash responses.error — status/message still sent', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402 });
    Object.defineProperty(err, 'details', {
      configurable: true,
      get() {
        throw new Error('boom from a getter');
      },
    });
    expect(() => responses.error(res, 402, 'Meter exhausted', 'explicit description')(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.message).toBe('Meter exhausted');
    expect(res._body.details).toBeUndefined();
  });
});

/**
 * Unit tests — finding-4 follow-up: `getDescription(description, err)`
 * used to re-read `err?.details` a SECOND time, unguarded, one frame below
 * the try/catch that captures `rawDetails` in `responses.error` (finding 4
 * above). For the DEFAULT call shape — `responses.error(res, status)(err)`,
 * no explicit `description`, no `error.description` — `getDescription`
 * reaches `typeof err?.details === 'string'` and a throwing `details`
 * accessor propagated out of `responses.error` anyway, even though finding 4
 * was supposedly fixed. Same for a `details` Proxy whose `get` trap throws:
 * capturing the Proxy REFERENCE once (`rawDetails = error.details`) never
 * touches the trap, so `getDescription`'s later `details.message` read was
 * still the first UNGUARDED property access on that hostile Proxy —
 * `pickWhitelistedDetails` runs first and already reads `details[key]`
 * inside its own per-key try/catch, so it never propagates. The existing
 * finding-4 test above never caught this because it passes an explicit
 * `description`, which returns before `getDescription` ever reads `details`.
 */
describe('responses.error — a throwing `details` getter/Proxy does not crash the DEFAULT call shape (finding-4 follow-up — getDescription second read):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a throwing `details` getter does not crash responses.error(res, status)(err) — no explicit description, no error.description', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402 });
    Object.defineProperty(err, 'details', {
      configurable: true,
      get() {
        throw new Error('boom from a getter');
      },
    });
    expect(() => responses.error(res, 402)(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.message).toBe('Meter exhausted');
    expect(res._body.details).toBeUndefined();
    expect(res._body.description).toBe('');
  });

  test('a `details` Proxy whose get trap throws does not crash responses.error(res, status)(err) — no explicit description, no error.description', () => {
    const res = buildRes();
    const hostileDetails = new Proxy(
      { upgradeUrl: '/billing/plans' },
      {
        get() {
          throw new Error('proxy get trap boom');
        },
      },
    );
    const err = new AppError('Meter exhausted', { status: 402, details: hostileDetails });
    expect(() => responses.error(res, 402)(err)).not.toThrow();
    expect(res._status).toBe(402);
    expect(res._body.message).toBe('Meter exhausted');
    // `hasOwnProperty` (used by `pickWhitelistedDetails`) forwards to the
    // Proxy's `getOwnPropertyDescriptor` trap, not `get` — this Proxy only
    // overrides `get`, so ownership checks pass and every whitelisted key's
    // VALUE read (`details[key]`) is what throws and gets dropped, leaving
    // no whitelisted key picked at all.
    expect(res._body.details).toBeUndefined();
    // getDescription's own `details.message` read hits the same `get` trap
    // and is caught the same way, falling through to the empty default.
    expect(res._body.description).toBe('');
  });
});

/**
 * Unit tests — `getDescription`'s pre-existing description-resolution
 * semantics (string `details`, array-of-`{message}` `details`, absent
 * `details`, explicit `description`, `error.description`) are OUT OF SCOPE
 * for the finding-4 follow-up above and must be byte-identical to before it: only
 * the SOURCE of the `details` value getDescription reads changed (a
 * pre-captured value instead of a live re-read of `err.details`), never the
 * resolution logic itself. Expected strings captured from the pre-fix
 * behavior directly (see PR #4056 discussion) — this is a behavior-lock, not
 * a spec derived from reasoning about the new code.
 *
 * Run under a DEV-GRADE env (issue #4059): these tests lock the RESOLUTION
 * LOGIC (which `details` shape wins, how it's turned into a string), which
 * still applies unchanged outside production. They used to run under
 * `production` because, before #4059, `getDescription` had no environment
 * gate at all — production and dev behaved identically. #4059 adds one (see
 * the "production-gated" describe block below for that new behavior), so
 * asserting full-text resolution now requires a dev-grade env; asserting it
 * under `production` would just test the gate, not the resolution logic.
 */
describe('responses.error — getDescription behavior preservation (finding-4 follow-up must not change these):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a string `details`, no explicit description, no error.description — description is the string itself', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: 'a string detail' });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('a string detail');
  });

  test('an array-of-{message} `details` — description is the joined messages', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: [{ message: 'first' }, { message: 'second' }],
    });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('first, second');
  });

  test('a mixed array `details` (message objects, plain strings, falsy, non-message objects) — non-matching entries are dropped', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: [{ message: 'first' }, 'plain', null, { other: 'x' }],
    });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('first, plain');
  });

  test('absent `details`, no explicit description, no error.description — description is the empty string', () => {
    const res = buildRes();
    // AppError's constructor always defaults `details` to `[{ message }]`
    // when none is passed — `delete` here gets a TRULY absent `details`,
    // matching a raw (non-AppError) error object handed to responses.error.
    const err = new AppError('Meter exhausted', { status: 402 });
    delete err.details;
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
  });

  test('an explicit `description` argument wins over `details`, even when `details` is set', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: 'should not be used' });
    responses.error(res, 402, 'Meter exhausted', 'explicit description')(err);
    expect(res._body.description).toBe('explicit description');
  });

  test('`error.description` wins over `details` when no explicit description argument is given', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: 'should not be used' });
    err.description = 'err-level description';
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('err-level description');
  });

  test('an object `details` with a `.message` (not a string, not an array) — description is that message', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: { message: 'object details message' } });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('object details message');
  });

  test('an object `details` with no `.message` and no whitelisted key — description is the empty string', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: { foo: 'bar' } });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
  });
});

/**
 * Unit tests — `getDescription`'s `details`-derived text is production-gated
 * (issue #4059, decision 2). Before this, `details.message` (and the string/
 * array-of-{message} shapes) reached `description` in EVERY environment,
 * including production — the second of the two leaks #4059 closes (the first
 * is the eight raw-caught-error call sites now curated to `details: { message
 * }`, covered elsewhere in the suite). "Generic in production" here means the
 * same '' every other unmatched `details` shape already falls through to —
 * there is no separate placeholder string to invent, mirroring how
 * `pickWhitelistedDetails` above drops an unlisted key rather than replacing
 * it with something. An explicit `description` argument or `err.description`
 * is a call site's own deliberate choice, never sourced from `details` — both
 * stay ungated in every environment, asserted below alongside the new gate so
 * a regression that over-applies the gate is caught the same run.
 */
describe('responses.error — getDescription details-derived text is production-gated (issue #4059):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('a string `details` never reaches `description` in production', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: 'internal: mongo replset primary at 10.0.4.12 unreachable' });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
  });

  test('an array-of-{message} `details` never reaches `description` in production', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: [{ message: 'first' }, { message: 'second' }] });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
  });

  test('an object `details.message` never reaches `description` in production — the exact leak reported in #4059', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: { message: 'internal: mongo replset primary at 10.0.4.12 unreachable' },
    });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
  });

  test('a curated call-site shape (details: { message: err.message }, the post-#4059 pattern at the eight call sites) never reaches `description` in production', () => {
    const res = buildRes();
    const caught = new Error('ECONNREFUSED 10.0.4.12:27017 — mongo replset primary unreachable');
    const err = new AppError('oAuth, find user failed', { code: 'SERVICE_ERROR', details: { message: caught.message } });
    responses.error(res, 500)(err);
    expect(res._body.description).toBe('');
    expect(res._body.details).toBeUndefined();
  });

  test('an explicit `description` argument still wins over `details` in production — not gated, a call site\'s own deliberate text', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: { message: 'should not be used' } });
    responses.error(res, 402, 'Meter exhausted', 'explicit description')(err);
    expect(res._body.description).toBe('explicit description');
  });

  test('`error.description` still wins over `details` in production when no explicit description argument is given — not gated', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', { status: 402, details: { message: 'should not be used' } });
    err.description = 'err-level description';
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('err-level description');
  });

  test('a whitelisted key (upgradeUrl/type) still crosses via `details` in production — the gate is on `description` text only, not the existing whitelist mechanism', () => {
    const res = buildRes();
    const err = new AppError('Meter exhausted', {
      status: 402,
      details: { type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' },
    });
    responses.error(res, 402)(err);
    expect(res._body.description).toBe('');
    expect(res._body.details).toEqual({ type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' });
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

  // Finding 2 (2026-09 review round): `config/index.js`'s DEVKIT_NODE_* array
  // parsing splits on `,` without trimming, so an operator-written
  // `"[upgradeUrl, planTier]"` produces a `' planTier'` (leading-space)
  // element. Left untrimmed, that element becomes a DEAD whitelist entry: it
  // can never match a real (unpadded) `details` property name, and
  // `pickWhitelistedDetails` drops the key with no warning. Fixed at the
  // `sanitizeConfigList` consumer, NOT at `config/index.js`'s splitting
  // (shared infra, out of scope).
  test('trims space-padded config entries so they match the real (unpadded) property name', () => {
    const whitelist = buildWhitelist([' planTier', 'quotaName ', '  bothSides  ']);
    expect(whitelist.has('planTier')).toBe(true);
    expect(whitelist.has('quotaName')).toBe(true);
    expect(whitelist.has('bothSides')).toBe(true);
    // The untrimmed (space-padded) forms must NOT also linger in the set.
    expect(whitelist.has(' planTier')).toBe(false);
    expect(whitelist.has('quotaName ')).toBe(false);
    expect(whitelist.has('  bothSides  ')).toBe(false);
  });

  test('end-to-end: whitelist built from an UNTRIMMED, comma-split raw value (config/index.js#146 shape) still picks up real property values', () => {
    // Reproduces the exact reported shape: `config/index.js`'s env-var
    // parsing splits `"[upgradeUrl, planTier, quotaName]"` on `,` WITHOUT
    // trimming, so the raw array handed to `buildWhitelist` is
    // `['upgradeUrl', ' planTier', ' quotaName']`.
    const rawSplitArray = '[upgradeUrl, planTier, quotaName]'.slice(1, -1).split(',');
    expect(rawSplitArray).toEqual(['upgradeUrl', ' planTier', ' quotaName']);
    const whitelist = buildWhitelist(rawSplitArray);
    const picked = pickWhitelistedDetails({ planTier: 'pro', quotaName: 'scraps' }, whitelist);
    expect(picked).toEqual({ planTier: 'pro', quotaName: 'scraps' });
  });

  test('drops entries that are empty (or all-whitespace) after trimming', () => {
    const whitelist = buildWhitelist([' ', '   ', 'realKey']);
    const extras = [...whitelist].filter((key) => !BUILT_INS.includes(key));
    expect(extras).toEqual(['realKey']);
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

/**
 * Unit tests — the `config.errors.detailsWhitelist` -> `buildWhitelist` WIRING
 * line itself (finding 1, 2026-09 review round). Every test above either
 * hand-passes a whitelist `Set` to `pickWhitelistedDetails`, or hand-calls
 * `buildWhitelist(someArray)` directly — none of them exercise the ONE line
 * in `responses.js` (`const DETAILS_WHITELIST = buildWhitelist(config?.errors
 * ?.detailsWhitelist);`) that actually reads config and feeds it into the
 * module-level singleton `responses.error` uses by default. That line runs
 * once at module-evaluation time, so reaching it requires a FRESH module
 * instance under a mocked `config/index.js` — `jest.resetModules()` +
 * `jest.unstable_mockModule()` + a dynamic `import()`, the same house
 * pattern `redactUrl.unit.tests.js`'s "redactUrl config sourcing" describe
 * block uses for the identical problem (a module-load-time config read).
 * `config/index.js` is mocked down to `{ default: {...} }` (no named
 * exports) to match how ~100 other test files in this repo mock it.
 */
describe('DETAILS_WHITELIST — config.errors.detailsWhitelist wiring reaches the module singleton (finding 1):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
  });

  /**
   * Load a fresh instance of responses.js under a given mocked config.
   * @param {Object|undefined} mockConfig - the value `config/index.js` default-exports
   * @returns {Promise<Object>} the freshly-loaded module's default export
   */
  const loadResponsesWithConfig = async (mockConfig) => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    const mod = await import('../responses.js');
    return mod.default;
  };

  test('a key placed at config.errors.detailsWhitelist reaches the effective whitelist responses.error uses by default', async () => {
    const freshResponses = await loadResponsesWithConfig({ errors: { detailsWhitelist: ['wiredExtraKey'] } });
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { wiredExtraKey: 'reached-via-config-wiring' } });
    freshResponses.error(res, 500)(err);
    expect(res._body.details).toEqual({ wiredExtraKey: 'reached-via-config-wiring' });
  });

  test('a missing config.errors leaves exactly the built-in defaults wired in (no config-extended key present)', async () => {
    const freshResponses = await loadResponsesWithConfig({});
    const res = buildRes();
    const err = new AppError('boom', { status: 500, details: { wiredExtraKey: 'should-not-appear', upgradeUrl: '/billing/plans' } });
    freshResponses.error(res, 500)(err);
    expect(res._body.details).toEqual({ upgradeUrl: '/billing/plans' });
  });
});
