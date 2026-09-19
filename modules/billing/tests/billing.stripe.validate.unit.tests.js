/**
 * Module dependencies.
 */
import { jest, describe, test, beforeAll, beforeEach, expect } from '@jest/globals';

import { isNonTransientStripeError } from '../lib/billing.stripe-errors.js';

/**
 * Build an error shaped like the ones stripe-node rejects with: the class name on `type`,
 * the wire type on `rawType`, plus `code` / `statusCode` when the API supplies them.
 * @param {string} type - SDK error class name
 * @param {Object} [fields] - rawType, code, statusCode
 * @returns {Error} Stripe-shaped error
 */
const stripeError = (type, fields = {}) => Object.assign(new Error(`${type} raised`), { type, ...fields });

/**
 * Unit tests for validateStripeKey — the boot-time probe that proves the configured Stripe
 * secret key actually works. The client is injected, so every outcome is driven by a plain
 * `{ accounts: { retrieve } }` stub; no request ever leaves the process.
 */
describe('validateStripeKey', () => {
  let validateStripeKey;
  let mockConfig;
  let retrieve;
  let client;

  beforeAll(async () => {
    mockConfig = { stripe: { secretKey: 'sk_test_123' } };
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    ({ validateStripeKey } = await import('../lib/stripe.js'));
  });

  beforeEach(() => {
    mockConfig.stripe.secretKey = 'sk_test_123';
    retrieve = jest.fn();
    client = { accounts: { retrieve } };
  });

  test('warns without calling Stripe when no client is configured', async () => {
    await expect(validateStripeKey(null)).resolves.toEqual({ status: 'warning', message: 'Stripe not configured' });
    await expect(validateStripeKey(undefined)).resolves.toEqual({ status: 'warning', message: 'Stripe not configured' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  test('reports ok with the account id when the key is accepted', async () => {
    retrieve.mockResolvedValue({ id: 'acct_123' });
    await expect(validateStripeKey(client)).resolves.toEqual({
      status: 'ok',
      message: 'Stripe key valid (acct_123, test mode)',
    });
  });

  test('retrieves the current account with per-request timeout and no retries (positional arity)', async () => {
    retrieve.mockResolvedValue({ id: 'acct_123' });
    await validateStripeKey(client);
    // A single options argument would be silently ignored by stripe-node — lock the exact shape.
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(null, {}, { timeout: 5000, maxNetworkRetries: 0 });
  });

  test.each([
    ['sk_live_abc', 'LIVE'],
    ['rk_live_abc', 'LIVE'],
    ['sk_test_abc', 'test'],
    ['rk_test_abc', 'test'],
  ])('derives the mode from the key prefix (%s → %s mode)', async (secretKey, mode) => {
    mockConfig.stripe.secretKey = secretKey;
    retrieve.mockResolvedValue({ id: 'acct_123' });
    const patch = await validateStripeKey(client);
    expect(patch.status).toBe('ok');
    expect(patch.message).toContain(`${mode} mode`);
  });

  test('reports error with the code when the key has expired', async () => {
    retrieve.mockRejectedValue(
      stripeError('StripeAuthenticationError', { rawType: 'invalid_request_error', code: 'api_key_expired', statusCode: 401 }),
    );
    await expect(validateStripeKey(client)).resolves.toEqual({ status: 'error', message: 'Stripe key REJECTED: api_key_expired' });
  });

  test('reports error when the key has been revoked', async () => {
    retrieve.mockRejectedValue(
      stripeError('StripeAuthenticationError', { rawType: 'invalid_request_error', code: 'api_key_revoked', statusCode: 401 }),
    );
    await expect(validateStripeKey(client)).resolves.toEqual({ status: 'error', message: 'Stripe key REJECTED: api_key_revoked' });
  });

  test('reports error on an unknown key, falling back to the wire type when no code is supplied', async () => {
    // The shape stripe-node produces for a key Stripe does not recognise: 401, no `code`.
    retrieve.mockRejectedValue(stripeError('StripeAuthenticationError', { rawType: 'invalid_request_error', statusCode: 401 }));
    await expect(validateStripeKey(client)).resolves.toEqual({
      status: 'error',
      message: 'Stripe key REJECTED: invalid_request_error',
    });
  });

  test('reports ok on a permission error — a restricted key without account read was still accepted', async () => {
    const err = stripeError('StripePermissionError', { rawType: 'invalid_request_error', statusCode: 403 });
    // The generic classifier calls a 403 deterministic; the dedicated branch must win over it.
    expect(isNonTransientStripeError(err)).toBe(true);
    retrieve.mockRejectedValue(err);
    await expect(validateStripeKey(client)).resolves.toEqual({
      status: 'ok',
      message: 'Stripe key accepted (account read not permitted)',
    });
  });

  test('reports ok on a bare 403 without an SDK class name', async () => {
    retrieve.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    await expect(validateStripeKey(client)).resolves.toMatchObject({ status: 'ok' });
  });

  test.each([
    ['StripeAPIError', { rawType: 'api_error', statusCode: 500 }],
    ['StripeConnectionError', {}],
    ['StripeRateLimitError', { rawType: 'rate_limit_error', statusCode: 429 }],
  ])('reports warning, not error, on a transient %s', async (type, fields) => {
    retrieve.mockRejectedValue(stripeError(type, fields));
    const patch = await validateStripeKey(client);
    expect(patch.status).toBe('warning');
    expect(patch.message).toMatch(/^Stripe key not validated \(transient: /);
  });

  test('never throws — a synchronous throw or a non-object rejection degrades to warning', async () => {
    retrieve.mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(validateStripeKey(client)).resolves.toMatchObject({ status: 'warning' });

    retrieve.mockReset();
    retrieve.mockRejectedValue('boom');
    await expect(validateStripeKey(client)).resolves.toEqual({
      status: 'warning',
      message: 'Stripe key not validated (transient: unknown)',
    });

    // A client without an accounts resource must not escape either.
    await expect(validateStripeKey({})).resolves.toMatchObject({ status: 'warning' });
  });
});
