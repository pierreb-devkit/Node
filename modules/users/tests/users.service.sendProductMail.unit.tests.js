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
const mockFindPage = jest.fn();
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
    findPage: mockFindPage,
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

const { default: UserService, walkSendProductMail } = await import('../services/users.service.js');
const { verifyUnsubscribeToken } = await import('../utils/unsubscribeToken.js');
const { default: config } = await import('../../../config/index.js');

const verifiedUser = { _id: '64b2f0000000000000000abc', id: '64b2f0000000000000000abc', email: 'a@test.com', emailVerified: true };

beforeEach(() => {
  mockFindWithFilter.mockReset();
  mockFindPage.mockReset();
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

  describe('two distinct URLs (epic-audit follow-up on #4160/#4127):', () => {
    test('the List-Unsubscribe header/token URL host matches config.api.*, NOT config.cors.origin — these resolve to different hosts in this real test config', async () => {
      // Guard the premise: if a future config change ever made these the
      // same host, this test would stop proving anything.
      expect(new URL(`http://${config.api.host}`).host).not.toBe(new URL(config.cors.origin[0]).host);

      await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
      const call = mockSendMail.mock.calls[0][0];
      const headerUrl = call.headers['List-Unsubscribe'].slice(1, -1);

      expect(new URL(headerUrl).host).toBe(`${config.api.host}:${config.api.port}`);
      expect(new URL(headerUrl).pathname).toBe(`/${config.api.base}/users/unsubscribe/${headerUrl.split('/').pop()}`);
    });

    test('params.emailSettingsUrl points at the frontend origin (config.cors.origin) + config.users.emailSettingsPath — distinct from the unsubscribe token URL', async () => {
      await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
      const call = mockSendMail.mock.calls[0][0];

      expect(call.params.emailSettingsUrl).toBe(`${config.cors.origin[0]}${config.users.emailSettingsPath}`);
      expect(call.params.emailSettingsUrl).not.toBe(call.params.unsubscribeUrl);
      expect(new URL(call.params.emailSettingsUrl).host).toBe(new URL(config.cors.origin[0]).host);
    });

    test('params.unsubscribeUrl is kept for backward compat and equals the List-Unsubscribe header URL', async () => {
      await UserService.sendProductMail(verifiedUser, { kind: 'news', template: 't', subject: 's' });
      const call = mockSendMail.mock.calls[0][0];

      expect(call.params.unsubscribeUrl).toBe(call.headers['List-Unsubscribe'].slice(1, -1));
    });
  });
});

describe('UserService.announce', () => {
  // Recipients are deliberately LEAN-shaped (no `id` virtual) — matches what
  // UserRepository.findPage actually returns in production (#4162). A mock with
  // a convenience `id` field would hide a regression that reads `recipient.id`.
  test('queries only verified, not-opted-out-for-this-kind users, projected to what sendProductMail reads', async () => {
    mockFindPage.mockResolvedValue([]);
    await UserService.announce({ kind: 'news', template: 't', subject: 's' });
    expect(mockFindPage).toHaveBeenCalledWith(
      { emailVerified: true, 'emailPreferences.news': { $ne: false } },
      { afterId: undefined, limit: 200, select: '_id email emailVerified emailPreferences' },
    );
  });

  test('sends to every recipient the first page returns and counts them', async () => {
    mockFindPage
      .mockResolvedValueOnce([
        { _id: '1', email: 'one@test.com', emailVerified: true },
        { _id: '2', email: 'two@test.com', emailVerified: true },
      ]);
    const result = await UserService.announce({ kind: 'news', template: 't', subject: 's' });
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2 });
    // page smaller than the page size (2 < 200) — walk stops, no extra query
    expect(mockFindPage).toHaveBeenCalledTimes(1);
  });

  test('walks a second _id-ordered page when the first page is full, and stops on a short page', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ _id: String(i + 1), email: `u${i + 1}@test.com`, emailVerified: true }));
    mockFindPage
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ _id: '201', email: 'u201@test.com', emailVerified: true }]);

    const result = await UserService.announce({ kind: 'news', template: 't', subject: 's' });

    expect(mockFindPage).toHaveBeenCalledTimes(2);
    expect(mockFindPage).toHaveBeenNthCalledWith(
      1,
      { emailVerified: true, 'emailPreferences.news': { $ne: false } },
      { afterId: undefined, limit: 200, select: '_id email emailVerified emailPreferences' },
    );
    expect(mockFindPage).toHaveBeenNthCalledWith(
      2,
      { emailVerified: true, 'emailPreferences.news': { $ne: false } },
      { afterId: '200', limit: 200, select: '_id email emailVerified emailPreferences' },
    );
    expect(mockSendMail).toHaveBeenCalledTimes(201);
    expect(result).toEqual({ sent: 201 });
  });

  test('a per-recipient send failure is logged by _id (no `id` virtual on a lean doc) and does NOT stop the loop', async () => {
    mockFindPage
      .mockResolvedValueOnce([
        { _id: '1', email: 'one@test.com', emailVerified: true },
        { _id: '2', email: 'two@test.com', emailVerified: true },
      ]);
    mockSendMail.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce({ accepted: ['two@test.com'], rejected: [] });

    const result = await UserService.announce({ kind: 'news', template: 't', subject: 's' });

    expect(mockSendMail).toHaveBeenCalledTimes(2); // second recipient still attempted
    expect(result).toEqual({ sent: 1 }); // only the successful send counts
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('announce'), expect.objectContaining({ userId: '1' }));
  });

  test('returns { sent: 0 } with no recipients', async () => {
    mockFindPage.mockResolvedValue([]);
    const result = await UserService.announce({ kind: 'onboarding', template: 't', subject: 's' });
    expect(result).toEqual({ sent: 0 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('UserService.walkSendProductMail (internal helper shared with the email-sequences cron, #4163)', () => {
  test('a per-recipient send failure is counted in `failed` and does NOT stop the walk', async () => {
    mockFindPage.mockResolvedValueOnce([
      { _id: '1', email: 'one@test.com', emailVerified: true },
      { _id: '2', email: 'two@test.com', emailVerified: true },
    ]);
    mockSendMail.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce({ accepted: ['two@test.com'], rejected: [] });

    const result = await walkSendProductMail({ emailVerified: true }, { kind: 'news', template: 't', subject: 's' });

    expect(mockSendMail).toHaveBeenCalledTimes(2); // second recipient still attempted
    expect(result).toEqual({ sent: 1, failed: 1 });
  });

  test('a findPage rejection on the FIRST page propagates — never caught here, no send attempted', async () => {
    mockFindPage.mockRejectedValueOnce(new Error('connection reset'));

    await expect(walkSendProductMail({ emailVerified: true }, { kind: 'news', template: 't', subject: 's' })).rejects.toThrow('connection reset');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a findPage rejection on a LATER page (after the first page already sent) still propagates', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ _id: String(i + 1), email: `u${i + 1}@test.com`, emailVerified: true }));
    mockFindPage.mockResolvedValueOnce(fullPage).mockRejectedValueOnce(new Error('connection reset'));

    await expect(walkSendProductMail({ emailVerified: true }, { kind: 'news', template: 't', subject: 's' })).rejects.toThrow('connection reset');
    // the first page's 200 recipients were already mailed before the second page's findPage threw —
    // this is exactly why the cron wraps each step's call to this helper in its own try/catch (#4163).
    expect(mockSendMail).toHaveBeenCalledTimes(200);
  });

  test('a custom pageSize is forwarded to findPage\'s `limit` and drives the walk\'s stop condition', async () => {
    // 2 recipients < pageSize 5 — the walk stops after this one page, no second findPage call.
    mockFindPage.mockResolvedValueOnce([{ _id: '1', email: 'one@test.com', emailVerified: true }, { _id: '2', email: 'two@test.com', emailVerified: true }]);

    await walkSendProductMail({ emailVerified: true }, { kind: 'news', template: 't', subject: 's' }, { pageSize: 5 });

    expect(mockFindPage).toHaveBeenCalledTimes(1);
    expect(mockFindPage).toHaveBeenCalledWith({ emailVerified: true }, { afterId: undefined, limit: 5, select: '_id email emailVerified emailPreferences' });
  });

  test('logLabel and logContext are merged into the per-recipient failure log (the cron\'s own call shape)', async () => {
    mockFindPage.mockResolvedValueOnce([{ _id: '1', email: 'one@test.com', emailVerified: true }]);
    mockSendMail.mockRejectedValueOnce(new Error('provider down'));

    await walkSendProductMail(
      { emailVerified: true },
      { kind: 'onboarding', template: 't', subject: 's' },
      { logLabel: '[cron.emailSequences]', logContext: { sequence: 'welcome', day: 7 } },
    );

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[cron.emailSequences]: send failed for one recipient',
      expect.objectContaining({ userId: '1', kind: 'onboarding', sequence: 'welcome', day: 7, message: 'provider down' }),
    );
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
