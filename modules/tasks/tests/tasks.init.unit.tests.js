/**
 * Unit tests — tasks.init registers an org-removal cleanup handler that delegates to TasksService.deleteMany.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockOnOrganizationRemoved = jest.fn();
const mockDeleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });

jest.unstable_mockModule('../../organizations/lib/orgRemoval.registry.js', () => ({
  onOrganizationRemoved: mockOnOrganizationRemoved,
}));

jest.unstable_mockModule('../services/tasks.service.js', () => ({
  default: { deleteMany: mockDeleteMany },
}));

const { default: tasksInit } = await import('../tasks.init.js');

describe('tasks.init', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('registers a single org-removal handler at boot', async () => {
    await tasksInit({});
    expect(mockOnOrganizationRemoved).toHaveBeenCalledTimes(1);
    expect(typeof mockOnOrganizationRemoved.mock.calls[0][0]).toBe('function');
  });

  test('the registered handler delegates to TasksService.deleteMany scoped by organizationId', async () => {
    await tasksInit({});
    const handler = mockOnOrganizationRemoved.mock.calls[0][0];

    await handler({ organizationId: 'org-1', organization: { _id: 'org-1' } });

    expect(mockDeleteMany).toHaveBeenCalledWith({ organizationId: 'org-1' });
  });

  test('importing tasks.init does not itself register — registration only happens on invocation (boot)', async () => {
    // Module import alone must not register; only the default export (run at boot) does.
    expect(mockOnOrganizationRemoved).not.toHaveBeenCalled();
    await tasksInit({});
    expect(mockOnOrganizationRemoved).toHaveBeenCalledTimes(1);
  });
});
