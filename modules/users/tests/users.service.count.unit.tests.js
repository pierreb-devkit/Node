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

// Mock repositories directly so mongoose.model('Organization') / mongoose.model('Membership')
// are never called at module-evaluation time (the service-level mocks above intercept call
// paths but ESM static imports on the real service files are still resolved by the V8 VM
// module linker in some Node/Jest versions — mocking at repository layer is the safe guard).
jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    removeById: jest.fn(),
    findOne: jest.fn(),
    exists: jest.fn(),
    update: jest.fn(),
    updateById: jest.fn(),
    setPlan: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

jest.unstable_mockModule('../../organizations/repositories/organizations.membership.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    aggregateCountByOrganizations: jest.fn(),
  },
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
