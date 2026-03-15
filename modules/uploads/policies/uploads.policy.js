/**
 * Upload ability definitions for CASL document-level authorization.
 */

/**
 * Define upload-related abilities for an authenticated user.
 * Platform admins get full access. Regular users can read any upload
 * and delete their own uploads (ownership via metadata.user).
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
 * Guests can only read uploads (public image access).
 * @param {Object} builder - CASL AbilityBuilder helpers
 * @param {Function} builder.can - Grant an ability
 */
export function uploadGuestAbilities({ can }) {
  can('read', 'Upload');
}
