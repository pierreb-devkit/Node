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

describe('organizationAbilities:', () => {
  describe('admin (roles includes "admin"):', () => {
    test('grants manage all, regardless of membership (no membership)', () => {
      const can = jest.fn();
      const cannot = jest.fn();
      organizationAbilities({ roles: ['admin'] }, null, { can, cannot });

      expect(can).toHaveBeenCalledWith('manage', 'all');
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });

    test('grants manage all and short-circuits even when a membership is present (owner)', () => {
      const can = jest.fn();
      const cannot = jest.fn();
      organizationAbilities({ roles: ['admin'] }, membershipFixture(MEMBERSHIP_ROLES.OWNER), { can, cannot });

      expect(can).toHaveBeenCalledWith('manage', 'all');
      // The admin branch returns immediately — never also grants the non-admin/
      // membership-scoped abilities below.
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });
  });

  describe('non-admin user — no membership:', () => {
    test('grants only create Organization', () => {
      const can = jest.fn();
      const cannot = jest.fn();
      organizationAbilities({ roles: ['user'] }, null, { can, cannot });

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledTimes(1);
      expect(cannot).not.toHaveBeenCalled();
    });

    test('grants create Organization even when roles is absent (non-array falls through, not admin)', () => {
      const can = jest.fn();
      organizationAbilities({}, null, { can, cannot: jest.fn() });

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-admin user — membership.role = owner:', () => {
    test('grants create Organization + manage Organization/Membership scoped to the org', () => {
      const can = jest.fn();
      const cannot = jest.fn();
      const membership = membershipFixture(MEMBERSHIP_ROLES.OWNER, 'org-owner-1');
      organizationAbilities({ roles: ['user'] }, membership, { can, cannot });

      expect(can).toHaveBeenCalledWith('create', 'Organization');
      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-owner-1' });
      expect(can).toHaveBeenCalledWith('manage', 'Membership', { organizationId: 'org-owner-1' });
      expect(can).toHaveBeenCalledTimes(3);
      expect(cannot).not.toHaveBeenCalled();
    });
  });

  describe('non-admin user — membership.role = admin:', () => {
    test('grants create Organization + read/update Organization (not delete) + read/create/delete Membership', () => {
      const can = jest.fn();
      const cannot = jest.fn();
      const membership = membershipFixture(MEMBERSHIP_ROLES.ADMIN, 'org-admin-1');
      organizationAbilities({ roles: ['user'] }, membership, { can, cannot });

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
      const can = jest.fn();
      const cannot = jest.fn();
      const membership = membershipFixture(MEMBERSHIP_ROLES.MEMBER, 'org-member-1');
      organizationAbilities({ roles: ['user'] }, membership, { can, cannot });

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
      const can = jest.fn();
      const membership = { role: MEMBERSHIP_ROLES.OWNER, organizationId: 'org-raw-1' };
      organizationAbilities({ roles: ['user'] }, membership, { can, cannot: jest.fn() });

      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-raw-1' });
      expect(can).toHaveBeenCalledWith('manage', 'Membership', { organizationId: 'org-raw-1' });
    });

    test('scopes abilities to the populated ._id when organizationId IS populated', () => {
      const can = jest.fn();
      const membership = membershipFixture(MEMBERSHIP_ROLES.OWNER, 'org-populated-1');
      organizationAbilities({ roles: ['user'] }, membership, { can, cannot: jest.fn() });

      expect(can).toHaveBeenCalledWith('manage', 'Organization', { _id: 'org-populated-1' });
    });
  });
});
