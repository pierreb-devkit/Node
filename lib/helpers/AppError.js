/**
 * Module dependencies
 */
const AppErrorCodes = {
  serverError: 'SERVER_ERROR',
};

/**
 * @desc Custom error class with Node + Express
 * @param {String} message error
 * @param {Object} options
 * @param {*} [options.details] - structured/whitelisted or curated-internal data (see
 *   `lib/helpers/responses.js#getDescription` — its `details`-derived text is
 *   production-gated, issue #4059)
 * @param {number} [options.status] - HTTP status code
 * @param {string} [options.code] - stable domain error code
 * @param {string} [options.description] - deliberately-authored, user-facing text a
 *   throw site chooses explicitly — NOT gated by `getDescription`'s production check
 *   (same precedence as an explicit `description` argument to `responses.error`; see
 *   that function's own doc comment). Use this for authored copy a real user should
 *   see in every environment; use `details` for internal/curated data instead.
 */

class AppError extends Error {
  constructor(message, { details, status, code, description } = {}) {
    super(message);
    // Set HTTP status code
    this.status = status || 500;

    // Set API error code
    this.code = code || AppErrorCodes.serverError;

    // Ensures that stack trace uses our subclass name
    this.name = this.constructor.name;

    // Share clean messages for api feedback
    if (details) this.details = details;
    else this.details = [{ message }];

    // Deliberately-authored, user-facing text — see the constructor's own JSDoc
    // above. Only set when the throw site explicitly passes it; everything else
    // that reads `err.description` (`getDescription`, `oauthErrorRedirect`)
    // already treats an absent value as "fall through to the next source".
    if (description) this.description = description;

    // Ensures the AppError subclass is sliced out of the
    // stack trace dump for clarity
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
