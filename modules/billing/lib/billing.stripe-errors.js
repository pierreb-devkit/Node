/**
 * Classify Stripe errors for retry / short-circuit decisions.
 *
 * stripe-node sets `err.type` to the error CLASS NAME (Error.js: `this.type = type || this.constructor.name`,
 * and every subclass passes its own name via `super(raw, 'StripeXError')`), while the raw API error type
 * string (e.g. `'invalid_request_error'`) lives on `err.rawType`. Unwrapped/raw API error objects instead
 * carry the wire type directly on `.type`. Both shapes are handled below.
 */

const NON_TRANSIENT_STRIPE_ERROR_CLASSES = new Set([
  'StripeInvalidRequestError', // 400/404 — bad params, deterministic
  'StripeAuthenticationError', // 401 — bad/missing API key, deterministic
  'StripePermissionError', // 403 — key lacks permission for the resource, deterministic
]);

/**
 * True when a Stripe error is deterministic and will never succeed on retry
 * (invalid request, authentication, or permission failures). Transient errors
 * (api_error/500, connection, rate_limit/429) return false so they keep retrying.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNonTransientStripeError(err) {
  if (!err || typeof err !== 'object') return false;
  // SDK-wrapped errors expose the class name on `.type`.
  if (NON_TRANSIENT_STRIPE_ERROR_CLASSES.has(err.type)) return true;
  // SDK mirrors the wire type on `.rawType`; unwrapped API error objects carry it on `.type`.
  return err.rawType === 'invalid_request_error' || err.type === 'invalid_request_error';
}
