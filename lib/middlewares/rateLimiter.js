/**
 * Centralized rate limiter middleware.
 * Reads named profiles from config.rateLimit and exports a limiter for each.
 */
import rateLimit from 'express-rate-limit';

import config from '../../config/index.js';

const limiters = {};
for (const [name, opts] of Object.entries(config.rateLimit || {})) {
  limiters[name] = rateLimit(opts);
}

export default limiters;
