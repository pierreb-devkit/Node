/**
 * Module dependencies
 */
import AuditService from '../services/audit.service.js';

/**
 * Default route prefixes to skip when auto-capturing audit events.
 * Health checks, docs, and static assets generate noise.
 * @type {string[]}
 */
const SKIP_PREFIXES = ['/public', '/favicon', '/api/docs', '/api/health'];

/**
 * Regex to match a 24-hex-char MongoDB ObjectId.
 * @type {RegExp}
 */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Derive a human-readable action from the Express route path.
 * e.g. `/api/auth/signin` → `auth.signin`
 *      `/api/organizations/:orgId/members/invite` → `organizations.invite`
 *      `/api/billing/checkout` → `billing.checkout`
 * @param {string} routePath - The Express matched route path (req.route.path)
 * @param {string} baseUrl - The Express baseUrl (req.baseUrl)
 * @returns {string} Dot-delimited action identifier
 */
const deriveAction = (routePath, baseUrl) => {
  const full = `${baseUrl || ''}${routePath || ''}`;
  // Strip /api/ prefix and split into segments
  const stripped = full.replace(/^\/api\//, '');
  const segments = stripped.split('/').filter(Boolean);

  // Filter out parameter segments (e.g. :orgId, :id)
  const meaningful = segments.filter((s) => !s.startsWith(':'));
  if (meaningful.length === 0) return 'unknown';

  // Use first segment as module, last as action
  if (meaningful.length === 1) return meaningful[0];
  return `${meaningful[0]}.${meaningful[meaningful.length - 1]}`;
};

/**
 * Derive the target type from the route path (first meaningful segment).
 * Maps common path segments to model names.
 * @param {string} routePath - The Express matched route path
 * @param {string} baseUrl - The Express baseUrl
 * @returns {string} The target type (capitalized) or empty string
 */
const deriveTargetType = (routePath, baseUrl) => {
  const full = `${baseUrl || ''}${routePath || ''}`;
  const stripped = full.replace(/^\/api\//, '');
  const segments = stripped.split('/').filter((s) => s && !s.startsWith(':'));
  if (segments.length === 0) return '';

  const segment = segments[0];
  const map = {
    auth: 'User',
    users: 'User',
    billing: 'Organization',
    organizations: 'Organization',
    tasks: 'Task',
  };
  return map[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
};

/**
 * Extract the first ObjectId-looking value from req.params.
 * @param {Object} params - Express req.params
 * @returns {string} The first ObjectId param value or empty string
 */
const deriveTargetId = (params) => {
  if (!params) return '';
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && OBJECT_ID_RE.test(value)) return value;
  }
  return '';
};

/**
 * Create an Express middleware that auto-captures audit log entries for
 * mutating API requests. Attaches a `res.on('finish')` listener so that
 * the status code is available when the event is recorded.
 *
 * Identity context (`req.user`, `req.organization`) is read lazily inside
 * the `finish` handler — not at middleware execution time — so the
 * middleware can safely be mounted before auth/org resolution.
 *
 * The middleware is a no-op when audit is disabled because
 * `AuditService.log()` itself short-circuits without config.
 *
 * @param {Object} [options] - Configuration options
 * @param {string[]} [options.skipPrefixes] - Route prefixes to skip
 * @returns {import('express').RequestHandler}
 */
const createAuditMiddleware = (options = {}) => {
  const prefixes = options.skipPrefixes || SKIP_PREFIXES;

  return (req, res, next) => {
    const rawUrl = req.originalUrl || req.url;
    const endpoint = (rawUrl || '').split('?')[0] || '/';

    // Skip routes that produce high-frequency, low-value events
    if (prefixes.some((prefix) => endpoint.startsWith(prefix))) {
      return next();
    }

    res.on('finish', () => {
      // Skip GET/HEAD/OPTIONS — reads don't need audit
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;

      // Skip unauthenticated requests (no user resolved)
      if (!req.user) return;

      // Only log successful mutations (2xx status codes)
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      // Derive action from the matched route
      const routePath = req.route?.path || '';
      const action = deriveAction(routePath, req.baseUrl);
      const targetType = deriveTargetType(routePath, req.baseUrl);
      const targetId = deriveTargetId(req.params);

      AuditService.log({
        action,
        req,
        targetType,
        targetId,
      }).catch(() => {});
    });

    return next();
  };
};

/**
 * Pre-built middleware instance using default options.
 * @type {import('express').RequestHandler}
 */
const auditMiddleware = createAuditMiddleware();

export { createAuditMiddleware, deriveAction, deriveTargetType, deriveTargetId, SKIP_PREFIXES };
export default auditMiddleware;
