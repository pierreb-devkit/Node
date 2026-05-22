/**
 * Module dependencies.
 */
import { jest, describe, test, afterEach, expect } from '@jest/globals';
import { retryWithBackoff } from '../lib/billing.retry.js';

/**
 * Unit tests for retryWithBackoff:
 *   - success / transient-retry / exhaustion paths
 *   - shouldRetry short-circuit on non-transient (deterministic) errors
 *   - argument validation
 * Retry-delay paths use fake timers so the suite never incurs real backoff waits.
 */
describe('retryWithBackoff', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns the result on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries a transient failure then resolves', async () => {
    jest.useFakeTimers();
    const fn = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, { attempts: 3, baseMs: 200 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws the last error after exhausting all attempts', async () => {
    jest.useFakeTimers();
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    const promise = retryWithBackoff(fn, { attempts: 3, baseMs: 200 });
    const assertion = expect(promise).rejects.toThrow('always fails');
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('short-circuits (1 call, not 3) when shouldRetry returns false', async () => {
    const err = Object.assign(new Error('bad params'), { type: 'invalid_request_error' });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, {
        attempts: 3,
        baseMs: 200,
        shouldRetry: (e) => e?.type !== 'StripeInvalidRequestError' && e?.type !== 'invalid_request_error',
      }),
    ).rejects.toThrow('bad params');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('short-circuits on the StripeInvalidRequestError class-name type too', async () => {
    // stripe-node exposes the error class name on .type in some SDK versions and the
    // raw API type string in others; the call-site predicate guards both, so cover both.
    const err = Object.assign(new Error('bad params'), { type: 'StripeInvalidRequestError' });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, {
        attempts: 3,
        baseMs: 200,
        shouldRetry: (e) => e?.type !== 'StripeInvalidRequestError' && e?.type !== 'invalid_request_error',
      }),
    ).rejects.toThrow('bad params');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries to exhaustion when shouldRetry returns true', async () => {
    jest.useFakeTimers();
    const fn = jest.fn().mockRejectedValue(new Error('transient'));
    const promise = retryWithBackoff(fn, {
      attempts: 3,
      baseMs: 200,
      shouldRetry: () => true,
    });
    const assertion = expect(promise).rejects.toThrow('transient');
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('rejects invalid attempts / baseMs / shouldRetry with TypeError', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn, { attempts: 0 })).rejects.toThrow(TypeError);
    await expect(retryWithBackoff(fn, { baseMs: -1 })).rejects.toThrow(TypeError);
    await expect(retryWithBackoff(fn, { shouldRetry: 'nope' })).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });
});
