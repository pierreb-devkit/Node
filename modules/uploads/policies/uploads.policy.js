/**
 * Upload ability definitions for CASL document-level authorization.
 */
import config from '../../../config/index.js';

/**
 * Upload kinds anyone may read (config `uploads.<kind>.guestRead === true`).
 * Both the config key and the entry's `kind` field are listed: the multer path
 * stores `kind`, `createFromBuffer` stores the key.
 * @returns {string[]} the guest-readable kinds
 */
const guestReadKinds = () =>
  Object.entries(config.uploads || {}).flatMap(([key, entry]) =>
    entry && typeof entry === 'object' && entry.guestRead === true ? [key, entry.kind].filter((k) => typeof k === 'string') : [],
  );

/**
 * Register upload-related subjects for document-level and path-level resolution.
 * @param {Object} registry - Subject registration helpers
 * @param {Function} registry.registerDocumentSubject - Register req property → subject type
 * @param {Function} registry.registerPathSubject - Register route path → subject type
 * @returns {void}
 */
export function uploadSubjectRegistration({ registerDocumentSubject, registerPathSubject }) {
  registerDocumentSubject('upload', 'Upload');
  registerPathSubject((p) => p.startsWith('/api/uploads'), 'Upload');
}

/**
 * Define upload-related abilities for an authenticated user.
 * Platform admins get full access. Regular users read guest-readable kinds,
 * plus their organization's uploads (or their own without a membership), and
 * delete their own uploads (ownership via metadata.user).
 * @param {Object} user - The authenticated user
 * @param {Object|null} membership - Optional organization membership (reserved for future use)
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function uploadAbilities(user, membership, { can }) {
  if (Array.isArray(user?.roles) && user.roles.includes('admin')) {
    can('manage', 'all');
    return;
  }
  can('read', 'Upload', { 'metadata.kind': { $in: guestReadKinds() } });
  if (membership && membership.organizationId) {
    const orgId = String(membership.organizationId._id || membership.organizationId);
    can('read', 'Upload', { 'metadata.organizationId': orgId });
    can('delete', 'Upload', { 'metadata.organizationId': orgId, 'metadata.user': String(user._id) });
  } else {
    // Users without a membership can only access their own uploads
    can('read', 'Upload', { 'metadata.user': String(user._id) });
    can('delete', 'Upload', { 'metadata.user': String(user._id) });
  }
}

/**
 * Define upload-related abilities for unauthenticated guests.
 * Guests read only uploads of a guest-readable kind (`guestRead: true`).
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function uploadGuestAbilities({ can }) {
  can('read', 'Upload', { 'metadata.kind': { $in: guestReadKinds() } });
}
