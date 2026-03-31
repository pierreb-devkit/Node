/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — verify that logger.warn is called when fire-and-forget emails
 * fail in organizations.membership.service (createJoinRequest, approveRequest, rejectRequest).
 */

const mockWarn = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: mockWarn, error: jest.fn(), info: jest.fn() },
}));

const mockUserGetBrut = jest.fn();
const mockUserUpdateById = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: mockUserGetBrut, updateById: mockUserUpdateById },
}));

const mockMembershipFindOne = jest.fn();
const mockMembershipCreate = jest.fn();
const mockMembershipUpdate = jest.fn();
const mockMembershipRemove = jest.fn();
const mockMembershipList = jest.fn();
jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
  default: {
    findOne: mockMembershipFindOne,
    create: mockMembershipCreate,
    update: mockMembershipUpdate,
    remove: mockMembershipRemove,
    list: mockMembershipList,
    count: jest.fn(),
  },
}));

const mockOrgGet = jest.fn();
jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
  default: { get: mockOrgGet },
}));

const mockSendMail = jest.fn();
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: {
    isConfigured: jest.fn().mockReturnValue(true),
    sendMail: mockSendMail,
  },
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

describe('organizations.membership.service silent-catch error logging:', () => {
  const emailError = new Error('mail down');
  const user = { id: 'u1', email: 'user@x.com', firstName: 'A', lastName: 'B', emailVerified: true };
  const org = { _id: 'org1', name: 'TestOrg' };

  test('createJoinRequest: should call logger.warn when admin notification email fails', async () => {
    mockWarn.mockClear();
    mockUserGetBrut.mockResolvedValueOnce({ ...user });
    mockMembershipFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockMembershipCreate.mockResolvedValueOnce({ _id: 'm1' });
    mockOrgGet.mockResolvedValueOnce(org);
    mockMembershipList.mockResolvedValueOnce([{ userId: { email: 'admin@x.com' } }]);
    mockSendMail.mockRejectedValueOnce(emailError);

    await MembershipService.createJoinRequest('u1', 'org1');

    await new Promise((r) => setTimeout(r, 20));

    expect(mockWarn).toHaveBeenCalledWith(
      'organizations.membership.createJoinRequest: admin notification email failed',
      { message: emailError.message, stack: emailError.stack },
    );
  });

  test('approveRequest: should call logger.warn when approval email fails', async () => {
    mockWarn.mockClear();
    const membership = {
      userId: { _id: 'u1' },
      organizationId: { _id: 'org1' },
      status: 'pending',
    };
    mockMembershipUpdate.mockResolvedValueOnce({ ...membership, status: 'active' });
    // First call: check currentOrganization (already set, skip updateById)
    mockUserGetBrut.mockResolvedValueOnce({ _id: 'u1', email: 'user@x.com', firstName: 'A', lastName: 'B', currentOrganization: 'org1' });
    // Second call: get user for email notification
    mockUserGetBrut.mockResolvedValueOnce({ _id: 'u1', email: 'user@x.com', firstName: 'A', lastName: 'B' });
    mockOrgGet.mockResolvedValueOnce(org);
    mockSendMail.mockRejectedValueOnce(emailError);

    await MembershipService.approveRequest(membership);

    await new Promise((r) => setTimeout(r, 20));

    expect(mockWarn).toHaveBeenCalledWith(
      'organizations.membership.approveRequest: approval email failed',
      { message: emailError.message, stack: emailError.stack },
    );
  });

  test('rejectRequest: should call logger.warn when rejection email fails', async () => {
    mockWarn.mockClear();
    const membership = {
      userId: { _id: 'u1' },
      organizationId: { _id: 'org1' },
    };
    mockUserGetBrut.mockResolvedValueOnce({ _id: 'u1', email: 'user@x.com', firstName: 'A', lastName: 'B' });
    mockOrgGet.mockResolvedValueOnce(org);
    mockSendMail.mockRejectedValueOnce(emailError);
    mockMembershipRemove.mockResolvedValueOnce({});

    await MembershipService.rejectRequest(membership);

    await new Promise((r) => setTimeout(r, 20));

    expect(mockWarn).toHaveBeenCalledWith(
      'organizations.membership.rejectRequest: rejection email failed',
      { message: emailError.message, stack: emailError.stack },
    );
  });
});
