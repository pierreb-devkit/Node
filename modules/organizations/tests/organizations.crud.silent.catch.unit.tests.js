/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — verify that logger.error is called when DB rollback ops fail
 * in organizations.crud.service.
 */

const mockError = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockError, warn: jest.fn(), info: jest.fn() },
}));

const mockMembershipCreate = jest.fn().mockResolvedValue({ _id: 'm1' });
const mockMembershipDeleteMany = jest.fn();
const mockOrgCreate = jest.fn().mockResolvedValue({ _id: 'org1' });
const mockOrgRemove = jest.fn().mockResolvedValue({});
const mockUpdateById = jest.fn();

jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrgCreate,
    findOne: jest.fn().mockResolvedValue(null),
    remove: mockOrgRemove,
    list: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    get: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
  },
}));

jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: mockMembershipDeleteMany,
    list: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  },
}));

jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    updateById: mockUpdateById,
    findWithFilter: jest.fn().mockResolvedValue([]),
    getBrut: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../lib/helpers/emailVerification.js', () => ({
  assertEmailVerified: jest.fn(),
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { organizations: { enabled: false } },
}));

const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');

describe('organizations.crud.service silent-catch error logging:', () => {
  test('should call logger.error when membership rollback fails after org create error', async () => {
    const rollbackError = new Error('DB rollback failed');
    const createError = new Error('DB create failed');

    mockMembershipDeleteMany.mockRejectedValueOnce(rollbackError);
    mockOrgRemove.mockResolvedValueOnce({});
    mockUpdateById.mockRejectedValueOnce(createError);

    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };
    const body = { name: 'Test Org' };

    await expect(OrgCrudService.create(body, user)).rejects.toThrow();

    expect(mockError).toHaveBeenCalledWith(
      'organizations.crud.create: rollback membership failed',
      { message: rollbackError.message, stack: rollbackError.stack },
    );
  });
});
