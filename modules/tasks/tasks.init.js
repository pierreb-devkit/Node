/**
 * @module tasks/tasks.init
 * @description Boot-time wiring for the tasks module. Auto-discovered by the
 *   modules glob and invoked by initModulesConfiguration at startup.
 *   Registers an org-removal cleanup handler so org-scoped tasks are deleted
 *   when an organization is removed.
 */
import TasksService from './services/tasks.service.js';
import { onOrganizationRemoved } from '../organizations/lib/orgRemoval.registry.js';

export default async () => {
  onOrganizationRemoved(({ organizationId }) => TasksService.deleteMany({ organizationId }));
};
