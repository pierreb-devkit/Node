/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests — verify organizations.crud.service.create() emits `organization.created` on
 * the generic POST /api/organizations path, mirroring the invite/verify path
 * (organizations.service.js::createOrganizationForUser). Billing subscribes to this event
 * from billing.init.js and credits the one-shot signupGrant (#3952) — organizations no
 * longer imports the billing module directly (see modules/billing/tests/billing.init.unit.tests.js
 * for the subscriber-side coverage).
 */

const mockEmit = jest.fn();
jest.unstable_mockModule('../lib/events.js', () => ({
  default: { emit: mockEmit, on: jest.fn() },
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

describe('organizations.crud.service.create organization.created emit:', () => {
  beforeEach(() => {
    mockEmit.mockClear();
    mockOrgCreate.mockResolvedValue({ _id: 'org1', plan: 'free' });
  });

  test('emits organization.created for the freshly created org', async () => {
    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };
    const result = await OrgCrudService.create({ name: 'Test Org' }, user);

    expect(result).toEqual({ _id: 'org1', plan: 'free' });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('organization.created', { orgId: 'org1', planId: 'free' });
  });

  test('does not emit when membership creation fails (rollback exits before the emit)', async () => {
    mockMembershipCreate.mockRejectedValueOnce(new Error('membership boom'));
    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };

    await expect(OrgCrudService.create({ name: 'Rollback Org' }, user)).rejects.toThrow();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('a SYNCHRONOUS listener throw is swallowed — org creation still succeeds', async () => {
    mockEmit.mockImplementationOnce(() => { throw new Error('listener exploded'); });
    const user = { id: 'u1', _id: 'u1', email: 'a@b.com', emailVerified: true };

    const result = await OrgCrudService.create({ name: 'Test Org' }, user);

    expect(result).toEqual({ _id: 'org1', plan: 'free' });
  });
});
