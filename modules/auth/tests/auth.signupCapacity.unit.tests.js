import { jest } from '@jest/globals';
import { computeSignupCapacity } from '../services/auth.signupCapacity.js';

describe('computeSignupCapacity', () => {
  test('uncapped (null) → {cap:null, remaining:null} and count() not called', async () => {
    const countFn = jest.fn();
    await expect(computeSignupCapacity(null, countFn)).resolves.toEqual({ cap: null, remaining: null });
    expect(countFn).not.toHaveBeenCalled();
  });

  test('uncapped (undefined) → {cap:null, remaining:null}', async () => {
    const countFn = jest.fn();
    await expect(computeSignupCapacity(undefined, countFn)).resolves.toEqual({ cap: null, remaining: null });
    expect(countFn).not.toHaveBeenCalled();
  });

  test('capped → remaining = cap - count', async () => {
    const countFn = jest.fn().mockResolvedValue(10);
    await expect(computeSignupCapacity(50, countFn)).resolves.toEqual({ cap: 50, remaining: 40 });
  });

  test('at/over cap → remaining floored at 0', async () => {
    const countFn = jest.fn().mockResolvedValue(60);
    await expect(computeSignupCapacity(50, countFn)).resolves.toEqual({ cap: 50, remaining: 0 });
  });

  test('non-numeric cap → treated as uncapped', async () => {
    const countFn = jest.fn();
    await expect(computeSignupCapacity('abc', countFn)).resolves.toEqual({ cap: null, remaining: null });
    expect(countFn).not.toHaveBeenCalled();
  });

  test('cap = 0 → fully closed: {cap:0, remaining:0} and count IS called', async () => {
    const countFn = jest.fn().mockResolvedValue(0);
    await expect(computeSignupCapacity(0, countFn)).resolves.toEqual({ cap: 0, remaining: 0 });
    expect(countFn).toHaveBeenCalled();
  });

  test('numeric string cap ("42") → coerced: {cap:42, remaining:40}', async () => {
    const countFn = jest.fn().mockResolvedValue(2);
    await expect(computeSignupCapacity('42', countFn)).resolves.toEqual({ cap: 42, remaining: 40 });
  });
});
