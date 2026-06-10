import { jest } from '@jest/globals';

const Eligibility = (await import('../services/auth.eligibility.js')).default;
const { registerSignupEligibility, assertSignupEligible, _reset } = await import('../services/auth.eligibility.js');

beforeEach(() => {
  _reset();
});

describe('auth.eligibility registry', () => {
  test('assertSignupEligible returns null when no checks are registered', async () => {
    await expect(assertSignupEligible({ email: 'a@b.co' })).resolves.toBeNull();
  });

  test('returns null when every registered check returns nothing', async () => {
    registerSignupEligibility(() => {});
    registerSignupEligibility(async () => undefined);
    await expect(assertSignupEligible({ email: 'a@b.co' })).resolves.toBeNull();
  });

  test('runs every registered check, in order, with the same ctx', async () => {
    const order = [];
    const ctx = { email: 'a@b.co', body: { x: 1 }, req: {} };
    registerSignupEligibility((c) => { order.push(['a', c]); });
    registerSignupEligibility(async (c) => { order.push(['b', c]); });
    await assertSignupEligible(ctx);
    expect(order.map((o) => o[0])).toEqual(['a', 'b']);
    expect(order[0][1]).toBe(ctx);
    expect(order[1][1]).toBe(ctx);
  });

  test('returns the first non-null check result and still runs every check', async () => {
    const r1 = { invite: { id: 'a' } };
    const r2 = { invite: { id: 'b' } };
    const third = jest.fn();
    registerSignupEligibility(() => undefined); // contributes no result
    registerSignupEligibility(() => r1); // first non-null → this one wins
    registerSignupEligibility(() => r2); // later non-null is ignored
    registerSignupEligibility(third); // but EVERY check still runs (side-effects fire)
    const result = await assertSignupEligible({});
    expect(result).toBe(r1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  test('a throwing check aborts the chain (blocks signup) and propagates', async () => {
    const second = jest.fn();
    registerSignupEligibility(() => { throw new Error('blocked'); });
    registerSignupEligibility(second);
    await expect(assertSignupEligible({})).rejects.toThrow('blocked');
    expect(second).not.toHaveBeenCalled();
  });

  test('a rejecting async check propagates', async () => {
    registerSignupEligibility(async () => { throw new Error('async-blocked'); });
    await expect(assertSignupEligible({})).rejects.toThrow('async-blocked');
  });

  test('_reset clears the registry', async () => {
    const check = jest.fn();
    registerSignupEligibility(check);
    _reset();
    await assertSignupEligible({});
    expect(check).not.toHaveBeenCalled();
  });

  test('default export exposes the same functions', () => {
    expect(typeof Eligibility.registerSignupEligibility).toBe('function');
    expect(typeof Eligibility.assertSignupEligible).toBe('function');
    expect(typeof Eligibility._reset).toBe('function');
  });
});
