/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import { MEMBERSHIP_STATUSES, MEMBERSHIP_ROLES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * Consent unit tests for the membership service (P5a — #3813).
 *
 * Covers the two HARD INVARIANTS of the owner-add consent split:
 *   1. an owner_add membership is PENDING + source:'owner_add' and is activated
 *      ONLY by the invited user via acceptMembership — never by the owner;
 *   2. status/source comparisons use the lowercase constants, and a fresh
 *      owner-add is NEVER active.
 * Plus the source-scoping of createJoinRequest's single-pending rule (both
 * directions) and the exact-email user lookup.
 */

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockGet = jest.fn();
const mockList = jest.fn();
const mockCount = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    findOne: mockFindOne,
    create: mockCreate,
    update: mockUpdate,
    get: mockGet,
    list: mockList,
    count: mockCount,
  },
}));

const mockOrgGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: { get: mockOrgGet },
}));

const mockGetBrut = jest.fn();
const mockUpdateById = jest.fn().mockResolvedValue({});
const mockFindByEmail = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: mockGetBrut, updateById: mockUpdateById, findByEmail: mockFindByEmail },
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

describe('Membership consent service unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBrut.mockResolvedValue({ _id: USER });
    mockCreate.mockImplementation((data) => Promise.resolve({ _id: 'm-new', ...data }));
  });

  describe('addMember', () => {
    test('creates a PENDING owner_add membership (status set EXPLICITLY, never the active default)', async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await MembershipService.addMember(ORG, USER, MEMBERSHIP_ROLES.MEMBER, OWNER);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const payload = mockCreate.mock.calls[0][0];
      // Invariant #2: status is explicitly PENDING (the schema would otherwise default to 'active').
      expect(payload.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(payload.status).not.toBe(MEMBERSHIP_STATUSES.ACTIVE);
      expect(payload.source).toBe(PENDING_SOURCES.OWNER_ADD);
      expect(payload.userId).toBe(USER);
      expect(payload.organizationId).toBe(ORG);
      expect(payload.addedBy).toBe(OWNER);
      // A fresh owner-add is NEVER active.
      expect(result.status).toBe(MEMBERSHIP_STATUSES.PENDING);
    });

    test('defaults role to member when none is given', async () => {
      mockFindOne.mockResolvedValue(null);
      await MembershipService.addMember(ORG, USER, undefined, OWNER);
      expect(mockCreate.mock.calls[0][0].role).toBe(MEMBERSHIP_ROLES.MEMBER);
    });

    test('rejects when the user is already an ACTIVE member', async () => {
      mockFindOne.mockResolvedValue({ _id: 'm1', status: MEMBERSHIP_STATUSES.ACTIVE });
      await expect(MembershipService.addMember(ORG, USER, MEMBERSHIP_ROLES.MEMBER, OWNER))
        .rejects.toThrow('already a member');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('rejects when ANY pending membership already exists (no double-add / no stacking)', async () => {
      mockFindOne.mockResolvedValue({ _id: 'm1', status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST });
      await expect(MembershipService.addMember(ORG, USER, MEMBERSHIP_ROLES.MEMBER, OWNER))
        .rejects.toThrow('already has a pending membership');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('the duplicate-check is per-(user, org) across BOTH statuses', async () => {
      mockFindOne.mockResolvedValue(null);
      await MembershipService.addMember(ORG, USER, MEMBERSHIP_ROLES.MEMBER, OWNER);
      const filter = mockFindOne.mock.calls[0][0];
      expect(filter.userId).toBe(USER);
      expect(filter.organizationId).toBe(ORG);
      expect(filter.status.$in).toEqual(expect.arrayContaining([MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.PENDING]));
    });

    test('rejects when no userId is supplied', async () => {
      await expect(MembershipService.addMember(ORG, undefined, MEMBERSHIP_ROLES.MEMBER, OWNER))
        .rejects.toThrow('user is required');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('rejects when the target user does not exist', async () => {
      mockGetBrut.mockResolvedValue(null);
      await expect(MembershipService.addMember(ORG, USER, MEMBERSHIP_ROLES.MEMBER, OWNER))
        .rejects.toThrow('User not found');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('acceptMembership — consent gate', () => {
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
      save: jest.fn(),
      ...overrides,
    });

    test('the INVITED USER can accept their own pending owner_add → flips to ACTIVE', async () => {
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);
      mockUpdate.mockImplementation((m) => Promise.resolve(m));
      mockGetBrut.mockResolvedValue({ _id: USER, currentOrganization: null });

      const result = await MembershipService.acceptMembership('m1', USER);

      expect(result).not.toBeNull();
      expect(membership.status).toBe(MEMBERSHIP_STATUSES.ACTIVE);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    test('CONSENT BYPASS GUARD: the OWNER (a different user) CANNOT accept on the invitee behalf → null, no activation', async () => {
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.acceptMembership('m1', OWNER);

      expect(result).toBeNull();
      expect(membership.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('a JOIN REQUEST cannot be accepted via acceptMembership (only approveRequest activates it) → null', async () => {
      const membership = ownerAddPending({ source: PENDING_SOURCES.JOIN_REQUEST });
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.acceptMembership('m1', USER);

      expect(result).toBeNull();
      expect(membership.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('an already-ACTIVE membership is not re-accepted → null', async () => {
      const membership = ownerAddPending({ status: MEMBERSHIP_STATUSES.ACTIVE });
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.acceptMembership('m1', USER);

      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('an unknown membership id → null', async () => {
      mockGet.mockResolvedValue(null);
      const result = await MembershipService.acceptMembership('missing', USER);
      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('SELF-DEFENDING GATE: an undefined acceptingUserId → null, no activation (gate does not lean on the auth-only route)', async () => {
      // A valid pending owner_add exists, but the caller id is absent. The early
      // guard must reject BEFORE the String(undefined) identity compare could
      // sentinel-collide — proving the gate self-defends regardless of the route.
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);

      const result = await MembershipService.acceptMembership('m1', undefined);

      expect(result).toBeNull();
      expect(membership.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('matches the invited user even when userId is a populated sub-doc', async () => {
      const membership = ownerAddPending({ userId: { _id: USER, email: 'a@b.com' } });
      mockGet.mockResolvedValue(membership);
      mockUpdate.mockImplementation((m) => Promise.resolve(m));
      mockGetBrut.mockResolvedValue({ _id: USER, currentOrganization: ORG });

      const result = await MembershipService.acceptMembership('m1', USER);
      expect(result).not.toBeNull();
      expect(membership.status).toBe(MEMBERSHIP_STATUSES.ACTIVE);
    });

    test('sets currentOrganization when the accepting user has none (parity with approveRequest)', async () => {
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);
      mockUpdate.mockImplementation((m) => Promise.resolve(m));
      mockGetBrut.mockResolvedValue({ _id: USER, currentOrganization: null });

      await MembershipService.acceptMembership('m1', USER);
      expect(mockUpdateById).toHaveBeenCalledWith(USER, { currentOrganization: ORG });
    });

    test('does NOT overwrite an existing currentOrganization', async () => {
      const membership = ownerAddPending();
      mockGet.mockResolvedValue(membership);
      mockUpdate.mockImplementation((m) => Promise.resolve(m));
      mockGetBrut.mockResolvedValue({ _id: USER, currentOrganization: 'other-org' });

      await MembershipService.acceptMembership('m1', USER);
      expect(mockUpdateById).not.toHaveBeenCalled();
    });
  });

  describe('createJoinRequest single-pending rule — source scoping (both directions)', () => {
    beforeEach(() => {
      // First findOne (per-org duplicate) returns null → fall through to single-pending check.
      mockFindOne.mockResolvedValueOnce(null);
      mockGetBrut.mockResolvedValue({ _id: USER, email: 'u@x.com', emailVerified: true });
    });

    test('a pending OWNER_ADD does NOT block creating a join request (owner_add ⊥ join_request)', async () => {
      // The single-pending query is source-scoped to join_request, so it must find nothing.
      mockFindOne.mockResolvedValueOnce(null);

      await MembershipService.createJoinRequest(USER, ORG);

      // The single-pending guard query carried a join_request source scope.
      const singlePendingFilter = mockFindOne.mock.calls[1][0];
      expect(singlePendingFilter.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(JSON.stringify(singlePendingFilter)).toContain(PENDING_SOURCES.JOIN_REQUEST);
      // It created the join request (tagged join_request).
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].source).toBe(PENDING_SOURCES.JOIN_REQUEST);
    });

    test('an existing pending JOIN REQUEST in another org DOES block a new join request', async () => {
      mockFindOne.mockResolvedValueOnce({ _id: 'jr-elsewhere', status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST });
      await expect(MembershipService.createJoinRequest(USER, ORG)).rejects.toThrow('already have a pending request');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('createJoinRequest per-(user,org) duplicate guard', () => {
    test('a pending OWNER_ADD for the SAME org blocks a join request with an invitation-specific message', async () => {
      mockGetBrut.mockResolvedValue({ _id: USER, email: 'u@x.com', emailVerified: true });
      mockFindOne.mockResolvedValueOnce({ _id: 'inv', status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.OWNER_ADD });
      await expect(MembershipService.createJoinRequest(USER, ORG)).rejects.toThrow('pending invitation');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('source-scoped pending listings (E16 / invariant #1)', () => {
    test('listPending (owner approval surface) filters to join_request with an E17 legacy fallback', async () => {
      mockList.mockResolvedValue([]);
      await MembershipService.listPending(ORG);
      const filter = mockList.mock.calls[0][0];
      expect(filter.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      // join_request OR no source (pre-backfill legacy rows stay visible).
      expect(filter.$or).toEqual(expect.arrayContaining([
        { source: PENDING_SOURCES.JOIN_REQUEST },
        { source: { $exists: false } },
      ]));
    });

    test('listPendingByUser (auth-payload pendingRequests) is the same join_request scope', async () => {
      mockList.mockResolvedValue([]);
      await MembershipService.listPendingByUser(USER);
      const filter = mockList.mock.calls[0][0];
      expect(filter.userId).toBe(USER);
      expect(filter.$or).toBeDefined();
    });

    test('listPendingOwnerAddsByUser (my-pending invitations) filters to owner_add exactly (no legacy fallback)', async () => {
      mockList.mockResolvedValue([]);
      await MembershipService.listPendingOwnerAddsByUser(USER);
      const filter = mockList.mock.calls[0][0];
      expect(filter.status).toBe(MEMBERSHIP_STATUSES.PENDING);
      expect(filter.source).toBe(PENDING_SOURCES.OWNER_ADD);
      expect(filter.$or).toBeUndefined();
    });
  });

  describe('findUserByExactEmail', () => {
    test('returns minimal identity for a matched user', async () => {
      mockFindByEmail.mockResolvedValue({ _id: 'u9', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.com' });
      const result = await MembershipService.findUserByExactEmail('ada@x.com');
      expect(result).toEqual({ id: 'u9', displayName: 'Ada Lovelace', email: 'ada@x.com' });
    });

    test('returns null when no user matches', async () => {
      mockFindByEmail.mockResolvedValue(null);
      const result = await MembershipService.findUserByExactEmail('none@x.com');
      expect(result).toBeNull();
    });
  });
});
