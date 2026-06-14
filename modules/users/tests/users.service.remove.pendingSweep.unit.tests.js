/**
 * Unit tests — users.service.remove must sweep the deleted user's PENDING
 * membership rows (both join_request and owner_add): the cleanup loop iterates
 * listByUser, which is ACTIVE-only, so without the sweep pending rows survive
 * as orphans pointing at a dead userId. Issue #3831.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

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

describe('users.service.remove — pending membership sweep (#3831):', () => {
  const user = { _id: 'uid1', id: 'uid1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserRepositoryRemove.mockResolvedValue({ deletedCount: 1 });
    mockMembershipServiceDeleteMany.mockResolvedValue({});
    mockMembershipRepositoryDeleteMany.mockResolvedValue({ deletedCount: 0 });
  });

  test('sweeps the user PENDING rows (both sources) even with no active membership', async () => {
    mockMembershipServiceListByUser.mockResolvedValue([]);

    await UsersService.remove(user);

    expect(mockMembershipRepositoryDeleteMany).toHaveBeenCalledWith({ userId: 'uid1', status: 'pending' });
    expect(mockUserRepositoryRemove).toHaveBeenCalledTimes(1);
  });

  test('sweeps PENDING rows after processing active memberships (non-owner path)', async () => {
    mockMembershipServiceListByUser.mockResolvedValue([
      { _id: 'm1', role: 'member', organizationId: { _id: 'orgX' }, status: 'active' },
    ]);

    await UsersService.remove(user);

    // Active membership handled via the existing per-row delete...
    expect(mockMembershipServiceDeleteMany).toHaveBeenCalledWith({ _id: 'm1' });
    // ...and the pending sweep ran exactly once with the userId + pending filter.
    expect(mockMembershipRepositoryDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockMembershipRepositoryDeleteMany).toHaveBeenCalledWith({ userId: 'uid1', status: 'pending' });
  });
});
