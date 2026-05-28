/**
 * Unit tests — autoSetCurrentOrganization must not crash when membership.organizationId
 * is null after populate (deleted org, dangling ref). Issue #3709.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockMembershipFindOne = jest.fn();
const mockMembershipList = jest.fn();
const mockUpdateById = jest.fn();
const mockOrgRemove = jest.fn();

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: jest.fn(),
    findOne: jest.fn().mockResolvedValue(null),
    remove: mockOrgRemove,
    list: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    get: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
    updateById: jest.fn(),
  },
}));

jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: jest.fn(),
    deleteMany: jest.fn(),
    list: mockMembershipList,
    findOne: mockMembershipFindOne,
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
  default: { organizations: { enabled: true } },
}));

const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');

describe('autoSetCurrentOrganization — dangling org ref (#3709):', () => {
  const user = { _id: 'uid1', id: 'uid1', currentOrganization: null };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateById.mockResolvedValue({});
  });

  test('should not throw when membership.organizationId is null after populate', async () => {
    // Simulate: user has an active membership but the org is deleted (populate yields null)
    mockMembershipList.mockResolvedValue([
      { _id: 'm1', organizationId: null, status: 'active' },  // null = deleted org
    ]);

    // Must not throw; must set currentOrganization to null (no live org)
    const result = await OrgCrudService.autoSetCurrentOrganization({ ...user });
    expect(result.currentOrganization).toBeNull();
    expect(mockUpdateById).toHaveBeenCalledWith('uid1', { currentOrganization: null });
  });

  test('should skip null-org memberships and pick first live org when mixed', async () => {
    // Two memberships: first has deleted org (null populate), second has live org
    mockMembershipList.mockResolvedValue([
      { _id: 'm1', organizationId: null, status: 'active' },          // deleted org
      { _id: 'm2', organizationId: { _id: 'org2' }, status: 'active' }, // live org
    ]);

    const result = await OrgCrudService.autoSetCurrentOrganization({ ...user });
    expect(result.currentOrganization).toBe('org2');
    expect(mockUpdateById).toHaveBeenCalledWith('uid1', { currentOrganization: 'org2' });
  });

  test('should return user unchanged when currentOrganization is set and membership is live with a live org', async () => {
    const userWithOrg = { _id: 'uid1', id: 'uid1', currentOrganization: { _id: 'org1' } };
    mockMembershipFindOne.mockResolvedValue({ _id: 'm1', organizationId: { _id: 'org1' } });

    const result = await OrgCrudService.autoSetCurrentOrganization(userWithOrg);
    // Early return — no updateById called
    expect(mockUpdateById).not.toHaveBeenCalled();
    expect(result.currentOrganization).toEqual({ _id: 'org1' });
  });

  test('should fall through and clear currentOrganization when membership exists but org is null-populated', async () => {
    // Membership still exists (findOne returns it) but org is deleted (organizationId = null)
    const userWithOrg = { _id: 'uid1', id: 'uid1', currentOrganization: { _id: 'org1' } };
    // findOne called in early branch — membership exists (stillActive truthy) but org deleted
    mockMembershipFindOne.mockResolvedValue({ _id: 'm1', organizationId: null });
    // list called in fallback branch — also returns the same dangling membership
    mockMembershipList.mockResolvedValue([
      { _id: 'm1', organizationId: null, status: 'active' },
    ]);

    const result = await OrgCrudService.autoSetCurrentOrganization(userWithOrg);
    expect(result.currentOrganization).toBeNull();
    expect(mockUpdateById).toHaveBeenCalledWith('uid1', { currentOrganization: null });
  });
});
