/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import { MEMBERSHIP_STATUSES, MEMBERSHIP_ROLES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * Lifecycle unit tests for the pending owner_add membership (#3831).
 *
 * Covers the three service-level fixes:
 *   1. declineMembership — the invitee-side delete path, consent gate IDENTICAL
 *      to acceptMembership (pending + source owner_add + caller is the invitee);
 *   2. remove() last-owner scope — the protection only applies to ACTIVE owner
 *      rows, so cancelling a PENDING owner-role invite never spuriously throws;
 *   3. list() pending visibility — active members + pending owner_add invites,
 *      pending join_requests stay on their own approval surface (listPending).
 */

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockGet = jest.fn();
const mockList = jest.fn();
const mockCount = jest.fn();
const mockRemove = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    findOne: mockFindOne,
    create: mockCreate,
    update: mockUpdate,
    get: mockGet,
    list: mockList,
    count: mockCount,
    remove: mockRemove,
  },
}));

const mockOrgGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: { get: mockOrgGet },
}));

const mockGetBrut = jest.fn();
const mockUpdateById = jest.fn().mockResolvedValue({});
const mockSearchByNameOrEmail = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: mockGetBrut, updateById: mockUpdateById, searchByNameOrEmail: mockSearchByNameOrEmail },
}));

jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
}));
jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
  default: jest.fn().mockReturnValue('http://localhost:3000'),
}));
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { app: { title: 'Test' } },
}));
jest.unstable_mockModule('../../../lib/helpers/emailVerification.js', () => ({
  assertEmailVerified: jest.fn(),
}));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const { default: MembershipService } = await import('../services/organizations.membership.service.js');

const ORG = 'org1';
const USER = 'user1';
const OWNER = 'owner1';

describe('Membership owner_add lifecycle unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBrut.mockResolvedValue({ _id: USER, currentOrganization: 'other-org' });
    mockRemove.mockResolvedValue({ deletedCount: 1 });
  });

  describe('declineMembership — consent gate (mirror of acceptMembership)', () => {
    /**
     * @desc Build a pending owner_add membership owned by USER.
     * @param {Object} overrides - field overrides
     * @returns {Object} membership-like doc
     */
    const ownerAddPending = (overrides = {}) => ({
      _id: 'm1',
      userId: USER,
      organizationId: ORG,
      status: MEMBERSHIP_STATUSES.PENDING,
      source: PENDING_SOURCES.OWNER_ADD,
      ...overrides,
    });

    test('the INVITED USER can decline their own pending owner_add → row deleted and returned', async () => {
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.declineMembership('m1', USER);

      expect(result).toBe(membership);
      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(mockRemove).toHaveBeenCalledWith(membership);
    });

    test('a DIFFERENT user (e.g. the inviting owner) cannot decline → null, no deletion', async () => {
      mockGet.mockResolvedValue(ownerAddPending());

      const result = await MembershipService.declineMembership('m1', OWNER);

      expect(result).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('a JOIN REQUEST row cannot be declined here (owner reject path owns it) → null', async () => {
      mockGet.mockResolvedValue(ownerAddPending({ source: PENDING_SOURCES.JOIN_REQUEST }));

      const result = await MembershipService.declineMembership('m1', USER);

      expect(result).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('an ACTIVE membership cannot be declined (leave/remove own that path) → null', async () => {
      mockGet.mockResolvedValue(ownerAddPending({ status: MEMBERSHIP_STATUSES.ACTIVE }));

      const result = await MembershipService.declineMembership('m1', USER);

      expect(result).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('an unknown membership id → null', async () => {
      mockGet.mockResolvedValue(null);
      const result = await MembershipService.declineMembership('missing', USER);
      expect(result).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('SELF-DEFENDING GATE: an undefined decliningUserId → null, no deletion', async () => {
      mockGet.mockResolvedValue(ownerAddPending());
      const result = await MembershipService.declineMembership('m1', undefined);
      expect(result).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('matches the invitee even when userId is a populated sub-doc', async () => {
      const membership = ownerAddPending({ userId: { _id: USER, email: 'a@b.com' } });
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.declineMembership('m1', USER);
      expect(result).toBe(membership);
      expect(mockRemove).toHaveBeenCalledWith(membership);
    });
  });

  describe('remove() — last-owner protection scoped to ACTIVE owner rows', () => {
    test('cancelling a PENDING owner-role invite in a 1-active-owner org succeeds (guard skipped)', async () => {
      const invite = {
        _id: 'm2',
        userId: USER,
        organizationId: ORG,
        role: MEMBERSHIP_ROLES.OWNER,
        status: MEMBERSHIP_STATUSES.PENDING,
        source: PENDING_SOURCES.OWNER_ADD,
      };
      mockCount.mockResolvedValue(1); // would make the guard throw if it ran
      mockList.mockResolvedValue([]);

      await expect(MembershipService.remove(invite)).resolves.toEqual({ success: true });
      expect(mockCount).not.toHaveBeenCalled();
      expect(mockRemove).toHaveBeenCalledWith(invite);
    });

    test('removing the LAST ACTIVE owner still throws', async () => {
      const lastOwner = {
        _id: 'm3',
        userId: USER,
        organizationId: ORG,
        role: MEMBERSHIP_ROLES.OWNER,
        status: MEMBERSHIP_STATUSES.ACTIVE,
      };
      mockCount.mockResolvedValue(1);

      await expect(MembershipService.remove(lastOwner)).rejects.toThrow('at least one active owner');
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('removing an ACTIVE owner among several still succeeds (guard runs and passes)', async () => {
      const owner = {
        _id: 'm4',
        userId: USER,
        organizationId: ORG,
        role: MEMBERSHIP_ROLES.OWNER,
        status: MEMBERSHIP_STATUSES.ACTIVE,
      };
      mockCount.mockResolvedValue(2);
      mockList.mockResolvedValue([]);

      await expect(MembershipService.remove(owner)).resolves.toEqual({ success: true });
      expect(mockCount).toHaveBeenCalledTimes(1);
      expect(mockRemove).toHaveBeenCalledWith(owner);
    });
  });

  describe('list() — pending owner_add visibility for the inviting owner/admin', () => {
    test('filters to ACTIVE rows OR pending owner_add rows (pending join_requests stay out)', async () => {
      mockList.mockResolvedValue([]);

      await MembershipService.list(ORG);

      const filter = mockList.mock.calls[0][0];
      expect(filter.organizationId).toBe(ORG);
      expect(filter.status).toBeUndefined();
      expect(filter.$or).toEqual([
        { status: MEMBERSHIP_STATUSES.ACTIVE },
        { status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.OWNER_ADD },
      ]);
    });

    test('search still narrows by matched userIds on top of the $or filter', async () => {
      mockList.mockResolvedValue([]);
      mockSearchByNameOrEmail.mockResolvedValue([{ _id: 'u7' }]);

      await MembershipService.list(ORG, 'ada');

      const filter = mockList.mock.calls[0][0];
      expect(filter.userId).toEqual({ $in: ['u7'] });
      expect(filter.$or).toBeDefined();
    });
  });
});
