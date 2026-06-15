/**
 * Module dependencies
 */
import limiters from '../../../lib/middlewares/rateLimiter.js';
import publicDocs from '../controllers/publicDocs.controller.js';

/**
 * Register public, unauthenticated documentation routes.
 *
 * Both routes reuse the `api` rate-limit profile (per-IP/user cap). The payload
 * is cached in-process so occasional bursts are cheap, but the limiter is still
 * a safety net against scrapers. In environments where the profile is not
 * configured (e.g. dev) the limiter falls through to a passthrough.
 *
 * @param {import('express').Application} app - Express app instance
 * @returns {void}
 */
export default (app) => {
  // Docs content tree — { categories: [ { id, label, order, guides: [...] } ] }.
  // No auth, no org scoping: the guides are public reference content.
  app.route('/api/public/docs').get(limiters.api, publicDocs.tree);

  // Raw markdown body for a single guide (text/markdown). Unknown slug → 404.
  // The literal `.md` suffix is matched by path-to-regexp (Express 5), leaving
  // req.params.slug as the bare slug (e.g. `quickstart`).
  app.route('/api/public/docs/:slug.md').get(limiters.api, publicDocs.raw);
};
