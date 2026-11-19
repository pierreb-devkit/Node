/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for the public reads/writes other modules call instead of reaching
 * into the organizations repositories (billing, users).
 */

const mockMembershipFindOne = jest.fn();
const mockMembershipList = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: { findOne: mockMembershipFindOne, list: mockMembershipList },
}));

const mockOrgExists = jest.fn();
const mockOrgSetPlan = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: { exists: mockOrgExists, setPlan: mockOrgSetPlan },
}));

jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: jest.fn(), updateById: jest.fn() },
}));
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
}));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const { default: MembershipService } = await import('../services/organizations.membership.service.js');
const { default: OrganizationsService } = await import('../services/organizations.crud.service.js');

describe('Organizations public service methods unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('MembershipService.resolveMembership', () => {
    test('platform admin gets a synthetic owner membership without a lookup', async () => {
      const result = await MembershipService.resolveMembership({ _id: 'u1', roles: ['user', 'admin'] }, 'org1');
      expect(result).toEqual({ role: 'owner', organizationId: 'org1' });
      expect(mockMembershipFindOne).not.toHaveBeenCalled();
    });

    test('member gets their active membership row', async () => {
      const row = { _id: 'm1', role: 'member' };
      mockMembershipFindOne.mockResolvedValue(row);
      const result = await MembershipService.resolveMembership({ _id: 'u1', roles: ['user'] }, 'org1');
      expect(result).toBe(row);
      expect(mockMembershipFindOne).toHaveBeenCalledWith({ userId: 'u1', organizationId: 'org1', status: 'active' });
    });

    test('no user resolves to null', async () => {
      expect(await MembershipService.resolveMembership(undefined, 'org1')).toBeNull();
      expect(mockMembershipFindOne).not.toHaveBeenCalled();
    });
  });

  test('MembershipService.listActiveByRoles filters active rows by role', async () => {
    mockMembershipList.mockResolvedValue([]);
    await MembershipService.listActiveByRoles('org1', ['owner', 'admin']);
    expect(mockMembershipList).toHaveBeenCalledWith({ organizationId: 'org1', role: { $in: ['owner', 'admin'] }, status: 'active' });
  });

  test('MembershipService.findFirstActiveByUser returns the oldest active membership', async () => {
    mockMembershipFindOne.mockResolvedValue(null);
    await MembershipService.findFirstActiveByUser('u1');
    expect(mockMembershipFindOne).toHaveBeenCalledWith({ userId: 'u1', status: 'active' }, { sort: { createdAt: 1 } });
  });

  test('OrganizationsService.exists answers a boolean', async () => {
    mockOrgExists.mockResolvedValueOnce({ _id: 'org1' }).mockResolvedValueOnce(null);
    expect(await OrganizationsService.exists('org1')).toBe(true);
    expect(await OrganizationsService.exists('org2')).toBe(false);
    expect(mockOrgExists).toHaveBeenCalledWith({ _id: 'org1' });
  });

  test('OrganizationsService.setPlan delegates to the repository', async () => {
    mockOrgSetPlan.mockResolvedValue({ _id: 'org1', plan: 'free' });
    await expect(OrganizationsService.setPlan('org1', 'free')).resolves.toEqual({ _id: 'org1', plan: 'free' });
    expect(mockOrgSetPlan).toHaveBeenCalledWith('org1', 'free');
  });
});
