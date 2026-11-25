import { canManageMembers, canGrantRole } from '../lib/organizations.rights.js';

const platformAdmin = { roles: ['user', 'admin'] };
const user = { roles: ['user'] };
const as = (role) => ({ role, organizationId: 'org1' });

describe('organizations.rights', () => {
  test('canManageMembers: owner, admin and platform admin yes; member and non-member no', () => {
    expect(canManageMembers(user, as('owner'))).toBe(true);
    expect(canManageMembers(user, as('admin'))).toBe(true);
    expect(canManageMembers(platformAdmin, null)).toBe(true);
    expect(canManageMembers(user, as('member'))).toBe(false);
    expect(canManageMembers(user, null)).toBe(false);
  });

  test('canGrantRole: member for anyone; admin/owner only for an owner or platform admin', () => {
    expect(canGrantRole(user, as('admin'), 'member')).toBe(true);
    expect(canGrantRole(user, as('admin'), 'admin')).toBe(false);
    expect(canGrantRole(user, as('admin'), 'owner')).toBe(false);
    expect(canGrantRole(user, as('owner'), 'admin')).toBe(true);
    expect(canGrantRole(user, as('owner'), 'owner')).toBe(true);
    expect(canGrantRole(platformAdmin, null, 'owner')).toBe(true);
  });
});
