/**
 * Centralized rate limiter middleware.
 * Reads named profiles from config.rateLimit and exports a limiter for each.
 * When a profile is missing (e.g. in dev), returns a passthrough middleware.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import config from '../../config/index.js';

/**
 * @desc No-op middleware used when a rate-limit profile is not configured.
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 * @returns {void}
 */
const passthrough = (req, res, next) => next();

/**
 * @desc Default rate-limit key generator. Uses the authenticated user id when
 * available, otherwise falls back to an IPv6-safe IP key via ipKeyGenerator.
 * @param {import('express').Request} req - Express request object
 * @returns {string} User id when available, otherwise IPv6-safe IP key
 */
const defaultKeyGenerator = (req) => req.user?._id?.toString() || ipKeyGenerator(req.ip);

/**
 * @desc Proxy that lazily creates rate-limit middleware for each named profile.
 * Returns the configured limiter or a passthrough when the profile is missing.
 * @param {Object} target - Internal cache of created limiters
 * @param {string|symbol} name - The rate-limit profile name to look up
 * @returns {Function} Express middleware (rate limiter or passthrough)
 */
const limiters = new Proxy({}, {
  get(target, name) {
    if (name in target) return target[name];
    const opts = config.rateLimit?.[name];
    if (opts) {
      const keyGenerator = opts.keyGenerator ?? defaultKeyGenerator;
      target[name] = rateLimit({ ...opts, keyGenerator });
      return target[name];
    }
    return passthrough;
  },
});

export default limiters;
