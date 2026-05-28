/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockCount = jest.fn();

jest.unstable_mockModule('../repositories/users.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    search: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    stats: jest.fn(),
    count: mockCount,
    push: jest.fn(),
    searchByNameOrEmail: jest.fn(),
    findByEmail: jest.fn(),
    updateById: jest.fn(),
    findByIdAndUpdatePopulated: jest.fn(),
    findWithFilter: jest.fn(),
    updateMany: jest.fn(),
    linkProviderByEmail: jest.fn(),
  },
}));

jest.unstable_mockModule('../../auth/services/auth.service.js', () => ({
  default: { hashPassword: jest.fn(), comparePassword: jest.fn() },
}));

jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
  default: { listByUser: jest.fn(), create: jest.fn(), remove: jest.fn() },
}));

jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
  default: { create: jest.fn(), get: jest.fn(), remove: jest.fn() },
}));

jest.unstable_mockModule('../../organizations/lib/constants.js', () => ({
  MEMBERSHIP_ROLES: { OWNER: 'owner', MEMBER: 'member' },
  MEMBERSHIP_STATUSES: { ACTIVE: 'active', PENDING: 'pending' },
}));

jest.unstable_mockModule('../utils/sanitizeUser.js', () => ({
  removeSensitive: jest.fn((u) => u),
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { app: {}, db: {} },
}));

const { default: UserService } = await import('../services/users.service.js');

/**
 * Unit tests for UserService.count
 */
describe('UserService.count', () => {
  test('returns an exact document count from the repository', async () => {
    mockCount.mockResolvedValue(7);
    const result = await UserService.count();
    expect(mockCount).toHaveBeenCalledWith({});
    expect(result).toBe(7);
    mockCount.mockReset();
  });
});
