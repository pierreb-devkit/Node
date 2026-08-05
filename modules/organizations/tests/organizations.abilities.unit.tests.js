/**
 * Unit tests for organizationAbilities — the CASL ability-definition function
 * for the organizations module. Covers the full admin/user × owner/admin/member/
 * no-membership matrix (Node#4020, generic policy coverage the stack lacked).
 *
 * `can`/`cannot` are plain spies (no real CASL AbilityBuilder) — same convention
 * as modules/invitations/tests/invitations.policy.unit.tests.js.
 */
import { describe, test, expect, jest } from '@jest/globals';

import { organizationAbilities } from '../policies/organizations.policy.js';
import { MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * Build a membership fixture with a populated organizationId (the shape
 * MembershipRepository.findOne's defaultPopulate returns in production).
 * @param {string} role - one of MEMBERSHIP_ROLES
 * @param {string} organizationId - hex-ish id string
 * @returns {Object} membership fixture
 */
function membershipFixture(role, organizationId = '507f1f77bcf86cd799439011') {
  return { role, organizationId: { _id: organizationId } };
}

/**
 * Call organizationAbilities with fresh can/cannot spies and return them.
 * @param {Object} user - user fixture
 * @param {Object|null} membership - membership fixture
 * @returns {{can: jest.Mock, cannot: jest.Mock}} the spies, populated by the call
 */
function callAbilities(user, membership) {
  const can = jest.fn();
  const cannot = jest.fn();
  organizationAbilities(user, membership, { can, cannot });
  return { can, cannot };
}

describe('organizationAbilities:', () => {
  describe('admin (roles includes "admin"):', () => {
    test('grants manage all, regardless of membership (no membership)', () => {
      const { can, cannot } = callAbilities({ roles: ['admin'] }, null);

      expect(can).toHaveBeenCalledWith('manage', 'all');
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });

    test('grants manage all and short-circuits even when a membership is present (owner)', () => {
      const { can, cannot } = callAbilities({ roles: ['admin'] }, membershipFixture(MEMBERSHIP_ROLES.OWNER));

      expect(can).toHaveBeenCalledWith('manage', 'all');
      // The admin branch returns immediately — never also grants the non-admin/
      // membership-scoped abilities below.
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });
  });

  describe('non-admin user — no membership:', () => {
    test('grants only create Organization', () => {
      const { can, cannot } = callAbilities({ roles: ['user'] }, null);

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });

    test('grants create Organization even when roles is absent (non-array falls through, not admin)', () => {
      const { can } = callAbilities({}, null);

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-admin user — membership.role = owner:', () => {
    test('grants create Organization + manage Organization/Membership scoped to the org', () => {
      const membership = membershipFixture(MEMBERSHIP_ROLES.OWNER, 'org-owner-1');
      const { can, cannot } = callAbilities({ roles: ['user'] }, membership);

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-owner-1' });
      expect(can).toHaveBeenCalledWith('manage', 'Membership', { organizationId: 'org-owner-1' });
      expect(can).toHaveBeenCalledTimes(3);
      expect(cannot).not.toHaveBeenCalled();
    });
  });

  describe('non-admin user — membership.role = admin:', () => {
    test('grants create Organization + read/update Organization (not delete) + read/create/delete Membership', () => {
      const membership = membershipFixture(MEMBERSHIP_ROLES.ADMIN, 'org-admin-1');
      const { can, cannot } = callAbilities({ roles: ['user'] }, membership);

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledWith('read', 'Organization', { _id: 'org-admin-1' });
      expect(can).toHaveBeenCalledWith('update', 'Organization', { _id: 'org-admin-1' });
      expect(can).toHaveBeenCalledWith('read', 'Membership', { organizationId: 'org-admin-1' });
      expect(can).toHaveBeenCalledWith('create', 'Membership', { organizationId: 'org-admin-1' });
      expect(can).toHaveBeenCalledWith('delete', 'Membership', { organizationId: 'org-admin-1' });
      expect(can).toHaveBeenCalledTimes(6);

      expect(cannot).toHaveBeenCalledWith('delete', 'Organization');
      expect(cannot).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-admin user — membership.role = member:', () => {
    test('grants create Organization + read-only Organization/Membership, no write abilities', () => {
      const membership = membershipFixture(MEMBERSHIP_ROLES.MEMBER, 'org-member-1');
      const { can, cannot } = callAbilities({ roles: ['user'] }, membership);

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledWith('read', 'Organization', { _id: 'org-member-1' });
      expect(can).toHaveBeenCalledWith('read', 'Membership', { organizationId: 'org-member-1' });
      expect(can).toHaveBeenCalledTimes(3);
      expect(cannot).not.toHaveBeenCalled();

      expect(can).not.toHaveBeenCalledWith('manage', 'Organization', expect.anything());
      expect(can).not.toHaveBeenCalledWith('update', 'Organization', expect.anything());
      expect(can).not.toHaveBeenCalledWith('delete', expect.anything(), expect.anything());
    });
  });

  describe('membership.organizationId shape — populated vs. raw id:', () => {
    test('scopes abilities to the raw id when organizationId is NOT populated (no ._id)', () => {
      const membership = { role: MEMBERSHIP_ROLES.OWNER, organizationId: 'org-raw-1' };
      const { can } = callAbilities({ roles: ['user'] }, membership);

      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-raw-1' });
      expect(can).toHaveBeenCalledWith('manage', 'Membership', { organizationId: 'org-raw-1' });
    });

    test('scopes abilities to the populated ._id when organizationId IS populated', () => {
      const membership = membershipFixture(MEMBERSHIP_ROLES.OWNER, 'org-populated-1');
      const { can } = callAbilities({ roles: ['user'] }, membership);

      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-populated-1' });
    });
  });
});
