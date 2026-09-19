/**
 * Module dependencies
 */
import Stripe from 'stripe';

import config from '../../../config/index.js';
import { isNonTransientStripeError } from './billing.stripe-errors.js';

/**
 * Lazily instantiated Stripe client
 */
let stripeClient = null;

/**
 * Get or create the lazily-initialised Stripe client instance.
 * @returns {Object|null} Stripe client or null if not configured
 */
const getStripe = () => {
  if (stripeClient) return stripeClient;
  if (!config.stripe?.secretKey) return null;
  stripeClient = new Stripe(config.stripe.secretKey, { apiVersion: '2026-04-22.dahlia' });
  return stripeClient;
};

/**
 * Probe the configured secret key with a single cheap read, so a key that is present but
 * dead (expired, revoked, or issued for another account) is reported at boot instead of
 * surfacing on the first real charge. Takes the client as an argument so it can be
 * exercised with a plain stub, and never throws: it returns a readiness-row patch for the
 * caller to merge into the row it already built.
 *
 * @param {Object|null} stripe Stripe client, or null when billing is not configured
 * @returns {Promise<{status: string, message: string}>} Readiness row patch — status is 'ok', 'warning' or 'error'
 */
export const validateStripeKey = async (stripe) => {
  if (!stripe) return { status: 'warning', message: 'Stripe not configured' };

  try {
    // The arity is spelled out on purpose. `accounts.retrieve(id, params, options)` is strictly
    // positional in stripe-node: a lone options object lands in the `id` slot, still reaches
    // /v1/account, and its timeout/retry settings are silently dropped. `null` means "the account
    // this key belongs to". Per-request options keep the shared client's settings untouched.
    const account = await stripe.accounts.retrieve(null, {}, { timeout: 5000, maxNetworkRetries: 0 });
    // A response with no `error` field is passed through by the SDK unchanged, whatever its shape —
    // it never validates that the payload is actually a Stripe Account. Guard against a technically
    // "successful" but non-conforming reply (e.g. an intercepting proxy) reporting a healthy key.
    if (!account?.id) return { status: 'warning', message: 'Stripe key not validated (unexpected account response)' };
    // Mode comes from the key prefix: `livemode` is not part of the core Account object.
    const mode = /^(sk|rk)_live_/.test(config.stripe?.secretKey ?? '') ? 'LIVE' : 'test';
    return { status: 'ok', message: `Stripe key valid (${account.id}, ${mode} mode)` };
  } catch (err) {
    // A 403 proves the key was ACCEPTED — a restricted key without account-read permission answers
    // 403 here. This branch must stay ahead of the non-transient split below, which classes a
    // permission error as deterministic and would otherwise report a healthy key as rejected.
    // (`type` alone is sufficient: stripe-node's `generateV1Error` is the only place that ever sets
    // `.statusCode` on an error, and it unconditionally maps statusCode 403 to StripePermissionError —
    // so a `statusCode === 403` check can never fire independently of this `type` check.)
    if (err?.type === 'StripePermissionError') {
      return { status: 'ok', message: 'Stripe key accepted (account read not permitted)' };
    }
    // The SDK puts its class name on `type` and the wire type on `rawType`; `code` carries the
    // precise reason (e.g. api_key_expired) when the API supplies one. `type` outranks `rawType`:
    // Stripe's API answers a dead/revoked key with `rawType: 'invalid_request_error'` regardless of
    // the real cause, so falling back to it first would mislabel an auth failure as a bad request.
    const code = err?.code ?? err?.type ?? err?.rawType ?? 'unknown';
    if (isNonTransientStripeError(err)) return { status: 'error', message: `Stripe key REJECTED: ${code}` };
    // Network blips, 429s and 5xx say nothing about the key — do not cry wolf.
    return { status: 'warning', message: `Stripe key not validated (transient: ${code})` };
  }
};

export default getStripe;
