/**
 * Unit tests — users.service.remove deletion-cascade must not crash when
 * a co-member's membership.organizationId is null after populate (deleted org,
 * dangling ref). Same pattern guarded in autoSetCurrentOrganization. Issue #3709.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockMembershipServiceListByUser = jest.fn();
const mockMembershipServiceCount = jest.fn();
const mockMembershipServiceDeleteMany = jest.fn();
const mockMembershipRepositoryList = jest.fn();
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
    deleteMany: jest.fn(),
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

describe('users.service.remove deletion-cascade — dangling org ref (#3709):', () => {
  const ownerUser = { _id: 'ownerUid', id: 'ownerUid', currentOrganization: { _id: 'orgX' } };
  const orgId = 'orgX';

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserRepositoryRemove.mockResolvedValue({ deletedCount: 1 });
    mockMembershipServiceDeleteMany.mockResolvedValue({});
    mockOrgRepositoryRemove.mockResolvedValue({});
    mockMembershipServiceCount.mockResolvedValue(1); // sole owner
  });

  test('should not throw when co-member remaining membership.organizationId is null (deleted org)', async () => {
    // Owner user has one OWNER membership
    mockMembershipServiceListByUser.mockResolvedValue([
      { _id: 'm1', role: 'owner', organizationId: { _id: orgId }, status: 'active' },
    ]);
    mockMembershipServiceCount.mockResolvedValue(1); // sole owner → org deleted
    // One co-member (user B) whose currentOrganization = orgX
    mockUserRepositoryFindWithFilter.mockResolvedValue([{ _id: 'coUid' }]);
    // User B's remaining memberships: all point to deleted org (null populate)
    mockMembershipRepositoryList.mockResolvedValue([
      { _id: 'm2', organizationId: null, status: 'active' },
    ]);
    mockUserRepositoryUpdateById.mockResolvedValue({});

    // Must not throw; co-member's currentOrganization must be set to null
    await expect(UsersService.remove(ownerUser)).resolves.not.toThrow();
    expect(mockUserRepositoryUpdateById).toHaveBeenCalledWith('coUid', { currentOrganization: null });
  });

  test('should skip null-org memberships and pick first live org for co-member when mixed', async () => {
    mockMembershipServiceListByUser.mockResolvedValue([
      { _id: 'm1', role: 'owner', organizationId: { _id: orgId }, status: 'active' },
    ]);
    mockMembershipServiceCount.mockResolvedValue(1);
    mockUserRepositoryFindWithFilter.mockResolvedValue([{ _id: 'coUid' }]);
    // Co-member has two memberships: first null (deleted org), second live org
    mockMembershipRepositoryList.mockResolvedValue([
      { _id: 'm2', organizationId: null, status: 'active' },
      { _id: 'm3', organizationId: { _id: 'orgY' }, status: 'active' },
    ]);
    mockUserRepositoryUpdateById.mockResolvedValue({});

    await expect(UsersService.remove(ownerUser)).resolves.not.toThrow();
    // Must pick the live org (orgY), not crash on null._id
    expect(mockUserRepositoryUpdateById).toHaveBeenCalledWith('coUid', { currentOrganization: 'orgY' });
  });
});
