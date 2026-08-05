/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — verify that logger.error is called when DB rollback ops fail
 * in organizations.service (createOrganizationForUser).
 */

const mockError = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockError, warn: jest.fn(), info: jest.fn() },
}));

const mockMembershipCreate = jest.fn().mockResolvedValue({ _id: 'm1' });
const mockMembershipDeleteMany = jest.fn();
const mockOrgCreate = jest.fn().mockResolvedValue({ _id: 'org1' });
const mockOrgRemove = jest.fn().mockResolvedValue({});
const mockUpdateById = jest.fn();
const mockOrgExists = jest.fn().mockResolvedValue(false);

jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrgCreate,
    exists: mockOrgExists,
    remove: mockOrgRemove,
    list: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: mockMembershipDeleteMany,
    list: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { updateById: mockUpdateById },
}));

jest.unstable_mockModule('../services/organizations.membership.service.js', () => ({
  default: { createJoinRequest: jest.fn() },
}));

jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
  default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
}));

jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
  default: jest.fn().mockReturnValue([]),
}));

jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: jest.fn().mockReturnValue(false) },
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { organizations: { enabled: false }, app: { title: 'Test' } },
}));

jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
  slugify: jest.fn().mockReturnValue('test-org'),
  generateOrganizationSlug: jest.fn().mockResolvedValue('test-org'),
}));

// rule 2 (Node#4020): isolate the org-creation seam GENERICALLY — mock the hook
// mechanism itself (lib/events.js, a plain EventEmitter registry any consumer
// module can subscribe to), never a specific consumer's own listener module.
// This keeps the rollback-logging assertion below independent of whatever a
// consumer has registered on 'organization.created' / 'organization.provisioned'.
jest.unstable_mockModule('../lib/events.js', () => ({
  default: { emit: jest.fn(), on: jest.fn() },
}));

const { default: OrgService } = await import('../services/organizations.service.js');

describe('organizations.service silent-catch error logging:', () => {
  test('should call logger.error when membership rollback fails during createOrganizationForUser', async () => {
    const rollbackError = new Error('deleteMany failed');
    const updateError = new Error('updateById failed');

    mockMembershipDeleteMany.mockRejectedValueOnce(rollbackError);
    mockOrgRemove.mockResolvedValueOnce({});
    mockUpdateById.mockRejectedValueOnce(updateError);

    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B', emailVerified: true };

    await expect(OrgService.handleSignupOrganization(user)).rejects.toThrow();

    expect(mockError).toHaveBeenCalledWith(
      'organizations.service.createOrganizationForUser: rollback membership failed',
      { message: rollbackError.message, stack: rollbackError.stack },
    );
  });
});
