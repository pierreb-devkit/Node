/**
 * Unit tests — UserService.sendProductMail / announce / setEmailPreference (#4162).
 *
 * Mocks the repository + mailer + organizations seam (same pattern as
 * `users.service.count.unit.tests.js` — mocking the organizations
 * repositories directly, not just their services, keeps `mongoose.model('Organization')`
 * / `mongoose.model('Membership')` from ever being called at module-evaluation
 * time). `config/index.js` and `users.schema.js` are left REAL: `EmailKind`
 * validation and `getBaseUrl()` both need the real, fully-merged test config.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockFindWithFilter = jest.fn();
const mockSetEmailPreference = jest.fn();

jest.unstable_mockModule('../repositories/users.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    search: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    consumeEmailVerificationToken: jest.fn(),
    setEmailPreference: mockSetEmailPreference,
    remove: jest.fn(),
    stats: jest.fn(),
    count: jest.fn(),
    push: jest.fn(),
    searchByNameOrEmail: jest.fn(),
    findByEmail: jest.fn(),
    updateById: jest.fn(),
    findByIdAndUpdatePopulated: jest.fn(),
    findWithFilter: mockFindWithFilter,
    updateMany: jest.fn(),
    linkProviderByEmail: jest.fn(),
  },
}));

const mockSendMail = jest.fn();

jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { sendMail: mockSendMail, isConfigured: jest.fn().mockReturnValue(true), render: jest.fn(), getBrand: jest.fn() },
}));

const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../utils/sanitizeUser.js', () => ({
  removeSensitive: jest.fn((u) => u),
}));

jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
  default: { listByUser: jest.fn(), create: jest.fn(), remove: jest.fn() },
}));

jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
  default: { create: jest.fn(), get: jest.fn(), remove: jest.fn() },
}));

jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    removeById: jest.fn(),
    findOne: jest.fn(),
    exists: jest.fn(),
    update: jest.fn(),
    updateById: jest.fn(),
    setPlan: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

jest.unstable_mockModule('../../organizations/repositories/organizations.membership.repository.js', () => ({
  default: {
    list: jest.fn(),
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    aggregateCountByOrganizations: jest.fn(),
  },
}));

jest.unstable_mockModule('../../organizations/lib/constants.js', () => ({
  MEMBERSHIP_ROLES: { OWNER: 'owner', MEMBER: 'member' },
  MEMBERSHIP_STATUSES: { ACTIVE: 'active', PENDING: 'pending' },
}));

const { default: UserService } = await import('../services/users.service.js');
const { verifyUnsubscribeToken } = await import('../utils/unsubscribeToken.js');

const verifiedUser = { _id: '64b2f0000000000000000abc', id: '64b2f0000000000000000abc', email: 'a@test.com', emailVerified: true };

beforeEach(() => {
  mockFindWithFilter.mockReset();
  mockSetEmailPreference.mockReset();
  mockSendMail.mockReset().mockResolvedValue({ accepted: ['a@test.com'], rejected: [] });
  mockLoggerWarn.mockReset();
});

describe('UserService.sendProductMail', () => {
  test('rejects an unknown kind (defense in depth — EmailKind enum)', async () => {
    await expect(UserService.sendProductMail(verifiedUser, { kind: 'spam', template: 't', subject: 's' })).rejects.toThrow();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('skips (no send, no error) when the user has not verified their email', async () => {
    const result = await UserService.sendProductMail({ ...verifiedUser, emailVerified: false }, { kind: 'news', template: 't', subject: 's' });
    expect(result).toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('skips when the user explicitly opted out of this kind', async () => {
    const optedOut = { ...verifiedUser, emailPreferences: { news: false } };
    const result = await UserService.sendProductMail(optedOut, { kind: 'news', template: 't', subject: 's' });
    expect(result).toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends when emailPreferences is absent entirely (absent = on, no migration needed)', async () => {
    const result = await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
    expect(result).toEqual({ accepted: ['a@test.com'], rejected: [] });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('sends when the user opted out of the OTHER kind but not this one', async () => {
    const partialOptOut = { ...verifiedUser, emailPreferences: { onboarding: false } };
    const result = await UserService.sendProductMail(partialOptOut, { kind: 'news', template: 't', subject: 's' });
    expect(result).not.toBeNull();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('attaches the List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058)', async () => {
    await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
    const call = mockSendMail.mock.calls[0][0];
    expect(call.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(call.headers['List-Unsubscribe']).toMatch(/^<https?:\/\/.+>$/);
  });

  test('the unsubscribe URL embeds a token that verifies back to this user and kind', async () => {
    await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
    const call = mockSendMail.mock.calls[0][0];
    const url = call.headers['List-Unsubscribe'].slice(1, -1); // strip < >
    const token = url.split('/').pop();
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: '64b2f0000000000000000abc', kind: 'news' });
  });

  test('passes template/subject/from/replyTo through, and merges unsubscribeUrl into params without dropping caller params', async () => {
    await UserService.sendProductMail(verifiedUser, {
      kind: 'onboarding',
      template: 'onboarding-day-1',
      subject: 'Welcome',
      params: { displayName: 'Ada' },
      from: 'Team <team@test.com>',
      replyTo: 'support@test.com',
    });
    const call = mockSendMail.mock.calls[0][0];
    expect(call.template).toBe('onboarding-day-1');
    expect(call.subject).toBe('Welcome');
    expect(call.from).toBe('Team <team@test.com>');
    expect(call.replyTo).toBe('support@test.com');
    expect(call.params.displayName).toBe('Ada');
    expect(call.params.unsubscribeUrl).toMatch(/^https?:\/\//);
  });

  test('degrades to null when the mailer itself is unconfigured (same contract as mailer.sendMail)', async () => {
    mockSendMail.mockResolvedValue(null);
    const result = await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
    expect(result).toBeNull();
  });
});

describe('UserService.announce', () => {
  test('queries only verified, not-opted-out-for-this-kind users', async () => {
    mockFindWithFilter.mockResolvedValue([]);
    await UserService.announce({ kind: 'news', template: 't', subject: 's' });
    expect(mockFindWithFilter).toHaveBeenCalledWith({ emailVerified: true, 'emailPreferences.news': { $ne: false } });
  });

  test('sends to every recipient the query returns and counts them', async () => {
    mockFindWithFilter.mockResolvedValue([
      { _id: '1', id: '1', email: 'one@test.com', emailVerified: true },
      { _id: '2', id: '2', email: 'two@test.com', emailVerified: true },
    ]);
    const result = await UserService.announce({ kind: 'news', template: 't', subject: 's' });
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2 });
  });

  test('a per-recipient send failure is logged and does NOT stop the loop', async () => {
    mockFindWithFilter.mockResolvedValue([
      { _id: '1', id: '1', email: 'one@test.com', emailVerified: true },
      { _id: '2', id: '2', email: 'two@test.com', emailVerified: true },
    ]);
    mockSendMail.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce({ accepted: ['two@test.com'], rejected: [] });

    const result = await UserService.announce({ kind: 'news', template: 't', subject: 's' });

    expect(mockSendMail).toHaveBeenCalledTimes(2); // second recipient still attempted
    expect(result).toEqual({ sent: 1 }); // only the successful send counts
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('announce'), expect.objectContaining({ userId: '1' }));
  });

  test('returns { sent: 0 } with no recipients', async () => {
    mockFindWithFilter.mockResolvedValue([]);
    const result = await UserService.announce({ kind: 'onboarding', template: 't', subject: 's' });
    expect(result).toEqual({ sent: 0 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('UserService.setEmailPreference', () => {
  test('delegates to the repository and returns the sanitized result', async () => {
    mockSetEmailPreference.mockResolvedValue({ id: '64b2f0000000000000000abc', emailPreferences: { news: false } });
    const result = await UserService.setEmailPreference('64b2f0000000000000000abc', 'news', false);
    expect(mockSetEmailPreference).toHaveBeenCalledWith('64b2f0000000000000000abc', 'news', false);
    expect(result).toEqual({ id: '64b2f0000000000000000abc', emailPreferences: { news: false } });
  });

  test('returns null when the repository finds no match', async () => {
    mockSetEmailPreference.mockResolvedValue(null);
    const result = await UserService.setEmailPreference('000000000000000000000000', 'news', false);
    expect(result).toBeNull();
  });

  test('rejects an unknown kind before ever calling the repository', async () => {
    await expect(UserService.setEmailPreference('64b2f0000000000000000abc', 'spam', false)).rejects.toThrow();
    expect(mockSetEmailPreference).not.toHaveBeenCalled();
  });
});
