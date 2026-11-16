/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';

import { billingAbilities } from '../policies/billing.policy.js';
import { MEMBERSHIP_ROLES } from '../../organizations/lib/constants.js';

/**
 * Unit tests for billingAbilities with a real CASL AbilityBuilder: only organization
 * owners and admins can pay for the organization (checkout, extras checkout, Stripe
 * portal); every member keeps the billing read rights.
 */

const PAY_SUBJECTS = ['BillingCheckout', 'BillingPortal', 'BillingExtrasCheckout'];
const READ_SUBJECTS = ['BillingSubscription', 'BillingUsage', 'BillingExtrasBalance', 'BillingExtrasLedger'];

/**
 * Build a real CASL ability from billingAbilities.
 * @param {Object} user - user fixture
 * @param {Object|null} membership - membership fixture (plain object, as defineAbilityFor passes it)
 * @returns {import('@casl/ability').MongoAbility} built ability
 */
function buildAbility(user, membership) {
  const { can, cannot, build } = new AbilityBuilder(createMongoAbility);
  billingAbilities(user, membership, { can, cannot });
  return build();
}

/**
 * @param {string} role - membership role
 * @returns {Object} membership fixture
 */
const membership = (role) => ({ role, organizationId: '507f1f77bcf86cd799439011' });

const user = { _id: 'u1', roles: ['user'] };

describe('billingAbilities (real CASL):', () => {
  describe.each([MEMBERSHIP_ROLES.OWNER, MEMBERSHIP_ROLES.ADMIN])('%s', (role) => {
    test.each(PAY_SUBJECTS)('can create %s', (subject) => {
      expect(buildAbility(user, membership(role)).can('create', subject)).toBe(true);
    });

    test.each(READ_SUBJECTS)('can read %s', (subject) => {
      expect(buildAbility(user, membership(role)).can('read', subject)).toBe(true);
    });
  });

  describe('member', () => {
    test.each(PAY_SUBJECTS)('cannot create %s', (subject) => {
      expect(buildAbility(user, membership(MEMBERSHIP_ROLES.MEMBER)).can('create', subject)).toBe(false);
    });

    test.each(READ_SUBJECTS)('can still read %s', (subject) => {
      expect(buildAbility(user, membership(MEMBERSHIP_ROLES.MEMBER)).can('read', subject)).toBe(true);
    });
  });

  test('membership without a role gets no pay rights', () => {
    const ability = buildAbility(user, { organizationId: 'x' });
    for (const subject of PAY_SUBJECTS) expect(ability.can('create', subject)).toBe(false);
  });

  test('no membership gets no billing rights', () => {
    const ability = buildAbility(user, null);
    for (const subject of [...PAY_SUBJECTS, ...READ_SUBJECTS]) {
      expect(ability.can('create', subject)).toBe(false);
      expect(ability.can('read', subject)).toBe(false);
    }
  });

  test('platform admin manages everything, whatever the membership', () => {
    const ability = buildAbility({ roles: ['user', 'admin'] }, membership(MEMBERSHIP_ROLES.MEMBER));
    for (const subject of PAY_SUBJECTS) expect(ability.can('create', subject)).toBe(true);
  });
});
