import { jest } from '@jest/globals';

const Eligibility = (await import('../services/auth.eligibility.js')).default;
const { registerSignupEligibility, assertSignupEligible, _reset } = await import('../services/auth.eligibility.js');

beforeEach(() => {
  _reset();
});

describe('auth.eligibility registry', () => {
  test('assertSignupEligible is a no-op when no checks are registered', async () => {
    await expect(assertSignupEligible({ email: 'a@b.co' })).resolves.toBeUndefined();
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
