/**
 * Unit tests — OrgCrudService.remove() fires the org-removal registry and propagates handler errors.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockOrgRemove = jest.fn().mockResolvedValue({ acknowledged: true });
const mockMembershipDeleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
const mockMembershipList = jest.fn().mockResolvedValue([]);
const mockUpdateById = jest.fn().mockResolvedValue({});
const mockFindWithFilter = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
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

  test('propagates a handler error and aborts before the repository remove', async () => {
    onOrganizationRemoved(async () => {
      throw new Error('tasks cleanup failed');
    });

    await expect(OrgCrudService.remove(organization)).rejects.toThrow('tasks cleanup failed');
    expect(mockOrgRemove).not.toHaveBeenCalled();
  });

  test('with zero handlers registered, removes the organization without throwing', async () => {
    await expect(OrgCrudService.remove(organization)).resolves.toEqual({ acknowledged: true });
    expect(mockOrgRemove).toHaveBeenCalledWith(organization);
  });
});
