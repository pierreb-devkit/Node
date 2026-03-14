/**
 * Centralized rate limiter middleware.
 * Reads named profiles from config.rateLimit and exports a limiter for each.
 * When a profile is missing (e.g. in dev), returns a passthrough middleware.
 */
import rateLimit from 'express-rate-limit';

import config from '../../config/index.js';

const passthrough = (req, res, next) => next();

const limiters = new Proxy({}, {
  get(target, name) {
    if (name in target) return target[name];
    const opts = config.rateLimit?.[name];
    if (opts) {
      target[name] = rateLimit(opts);
      return target[name];
    }
    return passthrough;
  },
});

export default limiters;
