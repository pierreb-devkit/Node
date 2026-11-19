/**
 * @module uploads/uploads.init
 * @description Boot-time wiring for the uploads module. Auto-discovered by the
 *   modules glob and invoked by initModulesConfiguration at startup.
 *   Registers an org-removal cleanup handler so org-scoped uploads (and their
 *   stored files) are deleted when an organization is removed.
 */
import { onOrganizationRemoved } from '../organizations/lib/organizations.removal.registry.js';

/**
 * Uploads module initialisation.
 * The service is imported lazily inside the handler: its repository opens a
 * GridFS bucket on the live connection at import time.
 *
 * @returns {Promise<void>}
 */
export default async () => {
  onOrganizationRemoved(async ({ organizationId }) => {
    const { default: UploadsService } = await import('./services/uploads.service.js');
    await UploadsService.removeByOrganization(organizationId);
  });
};
