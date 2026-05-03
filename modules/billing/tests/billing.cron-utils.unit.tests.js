/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

describe('billing cron utils:', () => {
  let randomInt;
  let applyJitter;

  beforeEach(async () => {
    jest.resetModules();
    randomInt = jest.fn().mockReturnValue(0);
    jest.unstable_mockModule('node:crypto', () => ({ randomInt }));
    ({ applyJitter } = await import('../lib/billing.cron-utils.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('applyJitter uses crypto randomInt with configured max', async () => {
    const slept = await applyJitter(1234);

    expect(randomInt).toHaveBeenCalledWith(0, 1234);
    expect(slept).toBe(0);
  });

  test('applyJitter skips invalid or disabled jitter', async () => {
    await expect(applyJitter(0)).resolves.toBe(0);
    await expect(applyJitter(Infinity)).resolves.toBe(0);
    expect(randomInt).not.toHaveBeenCalled();
  });
});
