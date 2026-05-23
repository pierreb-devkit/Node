/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import { isNonTransientStripeError } from '../lib/billing.stripe-errors.js';

/**
 * Unit tests for isNonTransientStripeError — deterministic Stripe errors that
 * should short-circuit retries (invalid request / authentication / permission),
 * across both SDK-wrapped (.type = class name) and raw (.type = wire string) shapes.
 */
describe('isNonTransientStripeError', () => {
  test.each(['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError'])(
    'returns true for SDK error class %s (err.type = class name)',
    (type) => {
      expect(isNonTransientStripeError({ type })).toBe(true);
    },
  );

  test('returns true for an SDK-wrapped error carrying rawType invalid_request_error', () => {
    expect(
      isNonTransientStripeError({ type: 'StripeInvalidRequestError', rawType: 'invalid_request_error' }),
    ).toBe(true);
  });

  test('returns true for an unwrapped API error object (type = invalid_request_error)', () => {
    expect(isNonTransientStripeError({ type: 'invalid_request_error' })).toBe(true);
  });

  test.each(['StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError'])(
    'returns false for transient SDK error class %s',
    (type) => {
      expect(isNonTransientStripeError({ type })).toBe(false);
    },
  );

  test('returns false for a generic non-Stripe error', () => {
    expect(isNonTransientStripeError(new Error('boom'))).toBe(false);
  });

  test('returns false for null / undefined / non-object', () => {
    expect(isNonTransientStripeError(null)).toBe(false);
    expect(isNonTransientStripeError(undefined)).toBe(false);
    expect(isNonTransientStripeError('invalid_request_error')).toBe(false);
  });
});
