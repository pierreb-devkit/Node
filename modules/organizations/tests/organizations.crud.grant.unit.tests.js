/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests — verify organizations.crud.service.create() credits the one-shot
 * signup grant on the generic POST /api/organizations path, mirroring the
 * invite/verify path (organizations.service.js::createOrganizationForUser). A
 * fresh org on a plan that defines a signupGrant must not start at 0 balance.
 */

const mockGrantOnSignup = jest.fn().mockResolvedValue({ applied: true });
jest.unstable_mockModule('../../billing/services/billing.signupGrant.service.js', () => ({
  default: { grantOnSignup: mockGrantOnSignup },
}));

const mockOrgCreate = jest.fn().mockResolvedValue({ _id: 'org1', plan: 'free' });
const mockOrgRemove = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: {
    create: mockOrgCreate,
    findOne: jest.fn().mockResolvedValue(null),
    remove: mockOrgRemove,
    list: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    get: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
  },
}));

const mockMembershipCreate = jest.fn().mockResolvedValue({ _id: 'm1' });
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    create: mockMembershipCreate,
    deleteMany: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  },
}));

jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: {
    updateById: jest.fn().mockResolvedValue({}),
    findWithFilter: jest.fn().mockResolvedValue([]),
    getBrut: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../lib/helpers/emailVerification.js', () => ({
  assertEmailVerified: jest.fn(),
}));

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: { organizations: { enabled: false } },
}));

const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');

describe('organizations.crud.service.create signup grant:', () => {
  beforeEach(() => {
    mockGrantOnSignup.mockClear();
    mockOrgCreate.mockResolvedValue({ _id: 'org1', plan: 'free' });
  });

  test('credits the one-shot signup grant for the freshly created org', async () => {
    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };
    const result = await OrgCrudService.create({ name: 'Test Org' }, user);

    expect(result).toEqual({ _id: 'org1', plan: 'free' });
    expect(mockGrantOnSignup).toHaveBeenCalledTimes(1);
    expect(mockGrantOnSignup).toHaveBeenCalledWith({ orgId: 'org1', planId: 'free' });
  });

  test('defaults planId to free when the created org has no plan field', async () => {
    mockOrgCreate.mockResolvedValueOnce({ _id: 'org2' });
    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };
    await OrgCrudService.create({ name: 'No Plan Org' }, user);

    expect(mockGrantOnSignup).toHaveBeenCalledWith({ orgId: 'org2', planId: 'free' });
  });
});
