/**
 * Unit tests — deleting the sole-owner user of an organization must route the org
 * deletion through the canonical org-removal seam (organizations.crud.service.js#remove,
 * which calls runOrganizationRemovedHandlers) rather than the repository directly.
 * Otherwise modules that register an onOrganizationRemoved handler (e.g. tasks —
 * see modules/tasks/tasks.init.js) never get to clean up org-scoped data. Issue #3965.
 *
 * Also asserts the atomicity contract added to close a Phase-0 BLOCK finding: the org
 * removal seam is atomic-by-ordering (org doc + memberships always gone together,
 * handlers run best-effort AFTER), so a throwing onOrganizationRemoved handler can
 * never leave a zombie org, and a STRUCTURAL failure in the seam propagates and aborts
 * the whole user deletion (the user is never deleted on top of an inconsistent org).
 *
 * Uses the REAL org-removal registry (not mocked) so the assertion exercises the actual
 * seam, mirroring the pattern in organizations.crud.orgRemoval.unit.tests.js.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockMembershipServiceListByUser = jest.fn();
const mockMembershipServiceCount = jest.fn();
const mockMembershipServiceDeleteMany = jest.fn();
const mockMembershipRepositoryList = jest.fn();
const mockMembershipRepositoryDeleteMany = jest.fn();
const mockUserRepositoryFindWithFilter = jest.fn();
const mockUserRepositoryUpdateById = jest.fn();
const mockUserRepositoryRemove = jest.fn();
const mockOrgRepositoryRemove = jest.fn();

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.unstable_mockModule('../repositories/users.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    remove: mockUserRepositoryRemove,
    stats: jest.fn(),
    updateById: mockUserRepositoryUpdateById,
    findWithFilter: mockUserRepositoryFindWithFilter,
    findByIdAndUpdatePopulated: jest.fn(),
    searchByNameOrEmail: jest.fn(),
    search: jest.fn(),
  },
}));

jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
  default: {
    listByUser: mockMembershipServiceListByUser,
    count: mockMembershipServiceCount,
    deleteMany: mockMembershipServiceDeleteMany,
  },
}));

jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
  default: {
    remove: mockOrgRepositoryRemove,
    findOne: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
    updateById: jest.fn(),
  },
}));

jest.unstable_mockModule('../../organizations/repositories/organizations.membership.repository.js', () => ({
  default: {
    list: mockMembershipRepositoryList,
    findOne: jest.fn(),
    create: jest.fn(),
    deleteMany: mockMembershipRepositoryDeleteMany,
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { organizations: { enabled: true } },
}));

jest.unstable_mockModule('../utils/sanitizeUser.js', () => ({
  removeSensitive: jest.fn((u) => u),
}));

jest.unstable_mockModule('lodash', () => ({
  default: { pick: jest.fn((o) => o) },
}));

const { default: UsersService } = await import('../services/users.service.js');
const { onOrganizationRemoved, _reset } = await import('../../organizations/lib/orgRemoval.registry.js');

describe('users.service.remove — sole-owner org deletion routes through the org-removal seam (#3965):', () => {
  const orgId = 'orgX';
  const ownerUser = { _id: 'ownerUid', id: 'ownerUid', currentOrganization: { _id: orgId } };

  beforeEach(() => {
    jest.clearAllMocks();
    _reset();
    mockUserRepositoryRemove.mockResolvedValue({ deletedCount: 1 });
    mockMembershipServiceDeleteMany.mockResolvedValue({});
    mockMembershipRepositoryDeleteMany.mockResolvedValue({});
    mockOrgRepositoryRemove.mockResolvedValue({});
    mockMembershipServiceCount.mockResolvedValue(1); // sole owner
    mockUserRepositoryFindWithFilter.mockResolvedValue([]); // no co-members to reassign
    mockMembershipRepositoryList.mockResolvedValue([]);
    mockMembershipServiceListByUser.mockResolvedValue([
      { _id: 'm1', role: 'owner', organizationId: { _id: orgId }, status: 'active' },
    ]);
  });

  afterEach(() => {
    _reset();
  });

  test('fires the registered onOrganizationRemoved handler for the sole-owned org (task cleanup would run)', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(handler);

    await UsersService.remove(ownerUser);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ organizationId: orgId, organization: { _id: orgId } });
    // The org itself must still be removed after the handler runs
    expect(mockOrgRepositoryRemove).toHaveBeenCalledWith({ _id: orgId });
  });

  test('still deletes the user AND fully removes the org when a registered handler throws (no zombie org, no aborted user deletion)', async () => {
    const failingHandler = jest.fn().mockRejectedValue(new Error('task cleanup failed'));
    onOrganizationRemoved(failingHandler);

    await expect(UsersService.remove(ownerUser)).resolves.not.toThrow();

    expect(failingHandler).toHaveBeenCalledTimes(1);
    // The org doc must still be removed despite the handler failure — a handler error
    // is best-effort (logged) inside the removal seam, never a reason to leave a
    // zombie org doc with its memberships already wiped.
    expect(mockOrgRepositoryRemove).toHaveBeenCalledWith({ _id: orgId });
    // User deletion must still complete despite the downstream handler failure
    expect(mockUserRepositoryRemove).toHaveBeenCalledWith(ownerUser);
  });

  test('with zero handlers registered, still removes the org (no regression for orgs with no cleanup consumers)', async () => {
    await expect(UsersService.remove(ownerUser)).resolves.not.toThrow();
    expect(mockOrgRepositoryRemove).toHaveBeenCalledWith({ _id: orgId });
    expect(mockUserRepositoryRemove).toHaveBeenCalledWith(ownerUser);
  });

  test('aborts the user deletion when the org removal seam hits a STRUCTURAL failure (org repository delete throws) — user is NOT removed', async () => {
    const structuralError = new Error('org repository delete failed (simulated DB error)');
    mockOrgRepositoryRemove.mockRejectedValueOnce(structuralError);

    await expect(UsersService.remove(ownerUser)).rejects.toThrow('org repository delete failed');

    // The user must never be deleted on top of a teardown that genuinely broke.
    expect(mockUserRepositoryRemove).not.toHaveBeenCalled();
  });

  test('aborts the user deletion when the org removal seam hits a STRUCTURAL failure (membership wipe throws) — user is NOT removed', async () => {
    const structuralError = new Error('membership wipe failed (simulated DB error)');
    mockMembershipRepositoryDeleteMany.mockRejectedValueOnce(structuralError);

    await expect(UsersService.remove(ownerUser)).rejects.toThrow('membership wipe failed');

    expect(mockOrgRepositoryRemove).not.toHaveBeenCalled();
    expect(mockUserRepositoryRemove).not.toHaveBeenCalled();
  });
});
