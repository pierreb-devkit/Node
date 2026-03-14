/**
 * Module dependencies
 */
import path from 'path';
import responses from '../helpers/responses.js';

const methodToAction = {
  get: 'read', post: 'create', put: 'update', patch: 'update', delete: 'delete',
  head: 'read', options: 'read',
};

/**
 * Registry of ability builder functions discovered from module policy files.
 * Each entry is { fn, guest } where fn(user, membership, { can, cannot }) is called
 * for authenticated users and guest({ can, cannot }) is called for unauthenticated visitors.
 * @type {Array<{fn?: Function, guest?: Function}>}
 */
const abilitiesRegistry = [];

// Lazy CASL loader — dynamic import avoids Jest's experimental VM module linker
let _casl = null;

/**
 * Load CASL ability module on demand.
 * @returns {Promise<Object>} the @casl/ability module exports
 */
const loadCasl = async () => {
  if (!_casl) _casl = await import('@casl/ability');
  return _casl;
};

/**
 * Register ability builder functions from a module policy file.
 * @param {Object} entry - Object with optional `abilities` and `guestAbilities` functions
 * @param {Function} [entry.abilities] - Called with (user, membership, { can, cannot }) for authenticated users
 * @param {Function} [entry.guestAbilities] - Called with ({ can, cannot }) for guests
 */
const registerAbilities = (entry) => {
  abilitiesRegistry.push(entry);
};

/**
 * Build a CASL ability instance for a given user and optional membership.
 * Iterates over all registered ability builder functions from module policy files.
 * @param {Object|null} user - The authenticated user, or null/undefined for guests
 * @param {Object|null} [membership] - Optional organization membership (reserved for future use)
 * @returns {Promise<import('@casl/ability').Ability>} CASL ability instance
 */
const defineAbilityFor = async (user, membership) => {
  const { AbilityBuilder, Ability } = await loadCasl();
  const { can, cannot, build } = new AbilityBuilder(Ability);

  // Normalize Mongoose membership to a plain object so all fields (role, status, etc.)
  // are accessible, and flatten populated organizationId to a plain string ID.
  let normalizedMembership = membership;
  if (membership) {
    normalizedMembership = typeof membership.toObject === 'function'
      ? membership.toObject()
      : { ...membership };
    if (normalizedMembership.organizationId && normalizedMembership.organizationId._id) {
      normalizedMembership.organizationId = normalizedMembership.organizationId._id;
    }
  }

  for (const entry of abilitiesRegistry) {
    if (user && entry.abilities) {
      entry.abilities(user, normalizedMembership || null, { can, cannot });
    } else if (!user && entry.guestAbilities) {
      entry.guestAbilities({ can, cannot });
    }
  }

  return build();
};

/**
 * Normalize a Mongoose document (or populated sub-doc) into a plain object
 * where reference fields are reduced to their string ObjectId values, so that
 * CASL condition matching works correctly (avoids ObjectId reference inequality).
 * @param {Object} doc - Mongoose document or plain object
 * @returns {Object} plain object suitable for CASL condition matching
 */
const normalizeForCasl = (doc) => {
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  // Convert _id to string so CASL condition matching works (ObjectId !== String)
  if (plain._id) plain._id = String(plain._id);
  // Flatten populated user ref to a string id
  if (plain.user && plain.user._id) {
    plain.user = String(plain.user._id);
  } else if (plain.user) {
    plain.user = String(plain.user);
  }
  // Flatten nested metadata.user to string id
  if (plain.metadata && plain.metadata.user) {
    plain.metadata = { ...plain.metadata, user: String(plain.metadata.user) };
  }
  // Flatten nested metadata.organizationId to string id
  if (plain.metadata && plain.metadata.organizationId) {
    plain.metadata = {
      ...plain.metadata,
      organizationId: plain.metadata.organizationId._id
        ? String(plain.metadata.organizationId._id)
        : String(plain.metadata.organizationId),
    };
  }
  // Flatten populated organizationId ref to a string id
  if (plain.organizationId && plain.organizationId._id) {
    plain.organizationId = String(plain.organizationId._id);
  } else if (plain.organizationId) {
    plain.organizationId = String(plain.organizationId);
  }
  return plain;
};

/**
 * Resolve the CASL subject type string from a loaded document on the request.
 * Maps known req properties to their CASL subject type name.
 * Documents are normalized so populated references become bare ObjectIds.
 * @param {Object} req - Express request object
 * @returns {{ subjectType: string, document: Object }|null} subject info or null
 */
const resolveSubject = (req) => {
  if (req.task) return { subjectType: 'Task', document: normalizeForCasl(req.task) };
  if (req.upload) return { subjectType: 'Upload', document: normalizeForCasl(req.upload) };
  // For user admin routes, the loaded user is stored in req.model by userByID param middleware
  if (req.model) return { subjectType: 'UserAdmin', document: normalizeForCasl(req.model) };
  if (req.membershipDoc) return { subjectType: 'Membership', document: normalizeForCasl(req.membershipDoc) };
  if (req.organization) return { subjectType: 'Organization', document: normalizeForCasl(req.organization) };
  return null;
};

/**
 * Middleware to check if the current user is allowed to perform the
 * HTTP-method-derived CASL action on the current route's document.
 * For document-level routes (where a param middleware has loaded a document),
 * ownership conditions are checked automatically via CASL conditions.
 * For collection-level routes (list, create, stats), checks the action against
 * the subject type string.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const isAllowed = async (req, res, next) => {
  const action = methodToAction[req.method.toLowerCase()];
  if (!action) return responses.error(res, 405, 'Method Not Allowed', `HTTP method ${req.method} is not supported`)();

  const ability = await defineAbilityFor(req.user, req.membership || null);
  const subjectInfo = resolveSubject(req);

  if (subjectInfo) {
    // Document-level check — use the actual document with subject() helper
    const { subject } = await loadCasl();
    if (ability.can(action, subject(subjectInfo.subjectType, subjectInfo.document))) return next();
  } else {
    // Collection-level check — derive subject type from route path
    const subjectType = deriveSubjectType(req.route.path);
    if (subjectType && ability.can(action, subjectType)) return next();
  }

  return responses.error(res, 403, 'Unauthorized', 'User is not authorized')();
};

/**
 * Mapping of exact route paths to CASL subject types for account-related routes.
 * Self-service routes use 'UserAccount', admin routes use 'UserAdmin',
 * and the base '/api/users' uses 'UserSelf' to split update/delete (user).
 * @type {Object<string, string>}
 */
const USER_ROUTE_SUBJECTS = {
  '/api/users/me': 'UserAccount',
  '/api/users/terms': 'UserAccount',
  '/api/users/password': 'UserAccount',
  '/api/users/avatar': 'UserAccount',
  '/api/users/data': 'UserAccount',
  '/api/users/data/mail': 'UserAccount',
  '/api/users/stats': 'UserAccount',
  '/api/users': 'UserSelf',
};

/**
 * Derive a CASL subject type string from an Express route path.
 * Maps known route path prefixes to their corresponding subject type.
 * User routes are split into several subject types:
 *   - 'UserAccount' for self-service (me, terms, password, avatar, data)
 *   - 'UserSelf' for the base /api/users path (user update/delete own account + admin list)
 *   - 'UserAdmin' for admin management (get/update/delete by userId, pagination)
 * @param {string} routePath - Express route path (e.g. '/api/tasks' or '/api/users/me')
 * @returns {string|null} CASL subject type or null if not mappable
 */
const deriveSubjectType = (routePath) => {
  if (routePath.startsWith('/api/tasks')) return 'Task';
  if (routePath.startsWith('/api/uploads')) return 'Upload';
  if (routePath.startsWith('/api/home')) return 'Home';
  if (routePath.startsWith('/api/admin/organizations')) return 'Organization';
  if (routePath.includes('/requests')) return 'Membership';
  if (routePath.includes('/members')) return 'Membership';
  if (routePath.startsWith('/api/organizations')) return 'Organization';
  // Check exact account route matches first
  if (USER_ROUTE_SUBJECTS[routePath]) return USER_ROUTE_SUBJECTS[routePath];
  // Account routes fallback
  if (routePath.startsWith('/api/users')) return 'UserAccount';
  // Admin user routes (/:userId, /page/:userPage)
  if (routePath.startsWith('/api/admin/users')) return 'UserAdmin';
  return null;
};

/**
 * Auto-discover and register policy files from all modules.
 * Called during application startup in place of the old invokeRolesPolicies loop.
 * Each policy file is expected to export named functions (e.g. taskAbilities).
 * @param {string[]} policyPaths - Array of resolved file paths to policy modules
 * @returns {Promise<void>}
 */
const discoverPolicies = async (policyPaths) => {
  for (const policyPath of policyPaths) {
    const mod = await import(path.resolve(policyPath));
    const entry = {};
    // Find the abilities and guestAbilities exports by convention
    for (const [key, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.endsWith('guestabilities')) {
        entry.guestAbilities = value;
      } else if (normalizedKey.endsWith('abilities')) {
        entry.abilities = value;
      }
    }
    // Also support old invokeRolesPolicies pattern during transition — skip if new-style exports found
    if (entry.abilities || entry.guestAbilities) {
      registerAbilities(entry);
    } else if (mod.default && typeof mod.default.invokeRolesPolicies === 'function') {
      // Legacy fallback — call old-style registration
      mod.default.invokeRolesPolicies();
    }
  }
};

export default {
  registerAbilities,
  defineAbilityFor,
  isAllowed,
  discoverPolicies,
  deriveSubjectType,
};
