/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import { MEMBERSHIP_ROLES } from '../lib/constants.js';

/**
 * Unit tests — addMember invitation email (#3832).
 * The owner-add creates a PENDING membership the invitee must ACCEPT (consent
 * invariant #1), so the notification is an INVITATION — never a "you were
 * added" fait accompli:
 *   - mailer configured   → sendMail called once with the exact invite payload;
 *   - mailer unconfigured → sendMail never called, membership still created;
 *   - user without email  → sendMail never called, membership still created.
 */

const mockWarn = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: mockWarn, error: jest.fn(), info: jest.fn() },
}));

const mockGetBrut = jest.fn();
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: mockGetBrut, updateById: jest.fn().mockResolvedValue({}) },
}));

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    findOne: mockFindOne,
    create: mockCreate,
    update: jest.fn(),
    remove: jest.fn(),
    list: jest.fn(),
    count: jest.fn(),
    get: jest.fn(),
  },
}));

const mockOrgGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: { get: mockOrgGet },
}));

const mockIsConfigured = jest.fn();
const mockSendMail = jest.fn();
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: mockIsConfigured, sendMail: mockSendMail },
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

const { default: MembershipService } = await import('../services/organizations.membership.service.js');

describe('organizations.membership.service addMember invitation email:', () => {
  const user = { _id: 'u1', email: 'invitee@x.com', firstName: 'Ada', lastName: 'Lovelace' };
  const org = { _id: 'org1', name: 'TestOrg' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBrut.mockResolvedValue({ ...user });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockImplementation((data) => Promise.resolve({ _id: 'm-new', ...data }));
    mockOrgGet.mockResolvedValue(org);
    mockSendMail.mockResolvedValue({});
  });

  test('mailer configured: sends the invitation email with the exact payload', async () => {
    mockIsConfigured.mockReturnValue(true);

    const membership = await MembershipService.addMember('org1', 'u1', MEMBERSHIP_ROLES.MEMBER, 'owner1');

    expect(membership._id).toBe('m-new');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledWith({
      to: 'invitee@x.com',
      subject: 'You have been invited to join TestOrg',
      template: 'org-member-added',
      params: {
        displayName: 'Ada Lovelace',
        orgName: 'TestOrg',
        appName: 'Test',
        url: 'http://localhost:3000/users/organizations',
      },
    });
  });

  test('mailer NOT configured: creates the membership and never calls sendMail', async () => {
    mockIsConfigured.mockReturnValue(false);

    const membership = await MembershipService.addMember('org1', 'u1', MEMBERSHIP_ROLES.MEMBER, 'owner1');

    expect(membership._id).toBe('m-new');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('user without an email: creates the membership and never calls sendMail', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetBrut.mockResolvedValue({ _id: 'u1', firstName: 'Ada', lastName: 'Lovelace' });

    const membership = await MembershipService.addMember('org1', 'u1', MEMBERSHIP_ROLES.MEMBER, 'owner1');

    expect(membership._id).toBe('m-new');
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
