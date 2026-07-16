/**
 * Unit tests — OrgCrudService.remove() fires the org-removal registry and is atomic:
 * the org doc + memberships are always gone together before any handler runs, and a
 * handler error is caught + logged (best-effort), never re-thrown (#3965).
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockOrgRemove = jest.fn().mockResolvedValue({ acknowledged: true });
const mockMembershipDeleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
const mockMembershipList = jest.fn().mockResolvedValue([]);
const mockUpdateById = jest.fn().mockResolvedValue({});
const mockFindWithFilter = jest.fn().mockResolvedValue([]);
const mockLoggerError = jest.fn();

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockLoggerError, warn: jest.fn(), info: jest.fn() },
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { app: {}, get: jest.fn() },
}));

jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    remove: mockOrgRemove,
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    deleteMany: mockMembershipDeleteMany,
    list: mockMembershipList,
  },
}));

jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    updateById: mockUpdateById,
    findWithFilter: mockFindWithFilter,
    getBrut: jest.fn(),
  },
}));

const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');
const { onOrganizationRemoved, _reset } = await import('../lib/orgRemoval.registry.js');

describe('OrgCrudService.remove() — org-removal registry', () => {
  const organization = { _id: 'org-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    _reset();
  });

  test('fires every registered handler with { organizationId, organization }', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(handler);

    await OrgCrudService.remove(organization);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ organizationId: 'org-1', organization });
    expect(mockOrgRemove).toHaveBeenCalledWith(organization);
  });

  test('a handler error is best-effort — logged, never re-thrown, and the org is still fully removed (#3965)', async () => {
    onOrganizationRemoved(async () => {
      throw new Error('tasks cleanup failed');
    });

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    // The org repository delete ran BEFORE the handler — removal is atomic-by-ordering.
    expect(mockOrgRemove).toHaveBeenCalledWith(organization);
    expect(mockLoggerError).toHaveBeenCalledWith(
      'organizations.crud.remove: org-removal cleanup handler failed after the org was removed (needs reconciliation)',
      expect.objectContaining({ organizationId: 'org-1', message: 'tasks cleanup failed' }),
    );
  });

  test('isolates handler failures — a failing handler does not skip a later one, and every failure is logged (#3965)', async () => {
    const failingFirst = jest.fn().mockRejectedValue(new Error('tasks cleanup failed'));
    const succeedingSecond = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(failingFirst);
    onOrganizationRemoved(succeedingSecond);

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });

    // The second handler still ran despite the first throwing (per-handler isolation).
    expect(failingFirst).toHaveBeenCalledTimes(1);
    expect(succeedingSecond).toHaveBeenCalledTimes(1);
    expect(succeedingSecond).toHaveBeenCalledWith({ organizationId: 'org-1', organization });
    // The single failure is logged for reconciliation; the org is still fully removed.
    expect(mockOrgRemove).toHaveBeenCalledWith(organization);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      'organizations.crud.remove: org-removal cleanup handler failed after the org was removed (needs reconciliation)',
      expect.objectContaining({ organizationId: 'org-1', message: 'tasks cleanup failed' }),
    );
  });

  test('logs each failure when multiple handlers throw, and still runs every handler (#3965)', async () => {
    const failingA = jest.fn().mockRejectedValue(new Error('tasks cleanup failed'));
    const failingB = jest.fn().mockRejectedValue(new Error('files cleanup failed'));
    const succeeding = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(failingA);
    onOrganizationRemoved(failingB);
    onOrganizationRemoved(succeeding);

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });

    expect(failingA).toHaveBeenCalledTimes(1);
    expect(failingB).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
    // One log line per failing handler (both aggregated failures surfaced individually).
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      'organizations.crud.remove: org-removal cleanup handler failed after the org was removed (needs reconciliation)',
      expect.objectContaining({ organizationId: 'org-1', message: 'tasks cleanup failed' }),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      'organizations.crud.remove: org-removal cleanup handler failed after the org was removed (needs reconciliation)',
      expect.objectContaining({ organizationId: 'org-1', message: 'files cleanup failed' }),
    );
  });

  test('a STRUCTURAL failure (org repository delete itself throws) propagates and is NOT swallowed', async () => {
    mockOrgRemove.mockRejectedValueOnce(new Error('db delete failed'));

    await expect(OrgCrudService.remove(organization)).rejects.toThrow('db delete failed');
  });

  test('with zero handlers registered, removes the organization without throwing', async () => {
    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    expect(mockOrgRemove).toHaveBeenCalledWith(organization);
  });

  test('reassigns an affected user without throwing when their remaining membership.organizationId is null (dangling ref, #3709)', async () => {
    mockFindWithFilter.mockResolvedValueOnce([{ _id: 'coUid' }]);
    mockMembershipList.mockResolvedValueOnce([{ _id: 'm2', organizationId: null, status: 'active' }]);

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    expect(mockUpdateById).toHaveBeenCalledWith('coUid', { currentOrganization: null });
  });

  test('skips a null-org membership and picks the first live org when reassigning an affected user (mixed, #3709)', async () => {
    mockFindWithFilter.mockResolvedValueOnce([{ _id: 'coUid' }]);
    mockMembershipList.mockResolvedValueOnce([
      { _id: 'm2', organizationId: null, status: 'active' },
      { _id: 'm3', organizationId: { _id: 'orgY' }, status: 'active' },
    ]);

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    expect(mockUpdateById).toHaveBeenCalledWith('coUid', { currentOrganization: 'orgY' });
  });

  test('reassigns to a non-populated (raw id) organizationId when the membership was not populated', async () => {
    mockFindWithFilter.mockResolvedValueOnce([{ _id: 'coUid' }]);
    mockMembershipList.mockResolvedValueOnce([
      { _id: 'm4', organizationId: 'orgZ', status: 'active' },
    ]);

    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    expect(mockUpdateById).toHaveBeenCalledWith('coUid', { currentOrganization: 'orgZ' });
  });
});
