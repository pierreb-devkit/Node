/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import { MEMBERSHIP_STATUSES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * Unit tests for the membershipRequest controller — consent-critical surfaces (P5a, #3813):
 *   - requestByID (the owner approve/reject gate) must be INVISIBLE to owner_adds;
 *   - accept lets the invited user activate their owner_add (consent in the service);
 *   - listMinePending surfaces the user's owner_add invitations.
 */

const mockGet = jest.fn();
const mockAcceptMembership = jest.fn();
const mockDeclineMembership = jest.fn();
const mockListPendingOwnerAddsByUser = jest.fn();
const mockListPendingByUser = jest.fn();

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: {
    get: mockGet,
    acceptMembership: mockAcceptMembership,
    declineMembership: mockDeclineMembership,
    listPendingOwnerAddsByUser: mockListPendingOwnerAddsByUser,
    listPendingByUser: mockListPendingByUser,
    listPending: jest.fn(),
    createJoinRequest: jest.fn(),
    approveRequest: jest.fn(),
    rejectRequest: jest.fn(),
  },
}));

const { default: controller } = await import('../controllers/organizations.membershipRequest.controller.js');

/**
 * @desc Minimal Express-like res with spies.
 * @returns {Object} mock response
 */
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('membershipRequest controller — consent surfaces:', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('requestByID (owner approve/reject gate)', () => {
    const ORG = 'org1';
    const next = jest.fn();

    test('CONSENT INVARIANT #1: an owner_add PENDING is INVISIBLE here → 404 (owner can never approve it)', async () => {
      mockGet.mockResolvedValue({
        _id: 'm1', organizationId: ORG, status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.OWNER_ADD,
      });
      const req = { organization: { _id: ORG } };
      const res = mockRes();

      await controller.requestByID(req, res, next, 'm1');

      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
      expect(req.membershipRequest).toBeUndefined();
    });

    test('a join_request PENDING in the org is visible → next() with req.membershipRequest set', async () => {
      const doc = { _id: 'm2', organizationId: ORG, status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST };
      mockGet.mockResolvedValue(doc);
      const req = { organization: { _id: ORG } };
      const res = mockRes();

      await controller.requestByID(req, res, next, 'm2');

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.membershipRequest).toBe(doc);
    });

    test('E17: a legacy PENDING with NO source stays visible (pre-backfill rows are join requests)', async () => {
      const doc = { _id: 'm3', organizationId: ORG, status: MEMBERSHIP_STATUSES.PENDING };
      mockGet.mockResolvedValue(doc);
      const req = { organization: { _id: ORG } };
      const res = mockRes();

      await controller.requestByID(req, res, next, 'm3');

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.membershipRequest).toBe(doc);
    });

    test('a request for another org → 404', async () => {
      mockGet.mockResolvedValue({ _id: 'm4', organizationId: 'other', status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST });
      const req = { organization: { _id: ORG } };
      const res = mockRes();

      await controller.requestByID(req, res, next, 'm4');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('accept (invited user activates their owner_add)', () => {
    test('passes the membershipId + the AUTHENTICATED user to the service', async () => {
      mockAcceptMembership.mockResolvedValue({ id: 'm1', status: MEMBERSHIP_STATUSES.ACTIVE });
      const req = { params: { membershipId: 'm1' }, user: { _id: 'invitee' } };
      const res = mockRes();

      await controller.accept(req, res);

      expect(mockAcceptMembership).toHaveBeenCalledWith('m1', 'invitee');
      expect(res.status).not.toHaveBeenCalledWith(404);
    });

    test('a null service result (consent mismatch / not found) → 404, never leaks which', async () => {
      mockAcceptMembership.mockResolvedValue(null);
      const req = { params: { membershipId: 'm1' }, user: { _id: 'someone-else' } };
      const res = mockRes();

      await controller.accept(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('listMinePending (user owner_add invitations)', () => {
    test('returns the user pending owner_add invitations', async () => {
      mockListPendingOwnerAddsByUser.mockResolvedValue([{ id: 'inv1' }]);
      const req = { user: { _id: 'u1' } };
      const res = mockRes();

      await controller.listMinePending(req, res);

      expect(mockListPendingOwnerAddsByUser).toHaveBeenCalledWith('u1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [{ id: 'inv1' }] }));
    });
  });

  describe('decline (invited user declines their owner_add)', () => {
    test('passes the membershipId + the AUTHENTICATED user to the service', async () => {
      const deleted = { id: 'm1', status: 'pending', source: 'owner_add' };
      mockDeclineMembership.mockResolvedValue(deleted);
      const req = { params: { membershipId: 'm1' }, user: { _id: 'invitee' } };
      const res = mockRes();

      await controller.decline(req, res);

      expect(mockDeclineMembership).toHaveBeenCalledWith('m1', 'invitee');
      expect(res.status).not.toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: deleted }));
    });

    test('a null service result (consent mismatch / not found) → 404, never leaks which', async () => {
      mockDeclineMembership.mockResolvedValue(null);
      const req = { params: { membershipId: 'm1' }, user: { _id: 'someone-else' } };
      const res = mockRes();

      await controller.decline(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('falls back to req.user.id when _id is absent', async () => {
      const deleted = { id: 'm2', status: 'pending', source: 'owner_add' };
      mockDeclineMembership.mockResolvedValue(deleted);
      const req = { params: { membershipId: 'm2' }, user: { id: 'invitee2' } };
      const res = mockRes();

      await controller.decline(req, res);

      expect(mockDeclineMembership).toHaveBeenCalledWith('m2', 'invitee2');
    });

    test('service throws → 422 Unprocessable Entity', async () => {
      mockDeclineMembership.mockRejectedValue(new Error('db error'));
      const req = { params: { membershipId: 'm1' }, user: { _id: 'u1' } };
      const res = mockRes();

      await controller.decline(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
    });
  });
});
