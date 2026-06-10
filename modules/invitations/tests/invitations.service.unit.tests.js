import { jest } from '@jest/globals';

jest.unstable_mockModule('../repositories/invitations.repository.js', () => ({
  default: {
    create: jest.fn(),
    findByToken: jest.fn(),
    findByEmail: jest.fn(),
    consume: jest.fn(),
    list: jest.fn(),
    remove: jest.fn(),
    get: jest.fn(),
  },
}));

const mockMailer = { isConfigured: jest.fn(() => false), sendMail: jest.fn() };
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: mockMailer,
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    sign: { inviteExpiresInDays: 14 },
    app: { title: 'Test App', contact: 'contact@test.com' },
  },
}));

jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
  default: jest.fn(() => 'http://localhost:3000'),
}));

jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const InvitationRepository = (await import('../repositories/invitations.repository.js')).default;
const InvitationService = (await import('../services/invitations.service.js')).default;

describe('InvitationService.findValid', () => {
  const future = new Date(Date.now() + 3600000);
  test('returns null when token missing', async () => {
    expect(await InvitationService.findValid('')).toBeNull();
  });
  test('returns null when not found', async () => {
    InvitationRepository.findByToken.mockResolvedValue(null);
    expect(await InvitationService.findValid('tok')).toBeNull();
  });
  test('returns null when used', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ usedAt: new Date(), expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok')).toBeNull();
  });
  test('returns null when expired', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ usedAt: null, expiresAt: new Date(Date.now() - 1000), email: 'a@b.co' });
    expect(await InvitationService.findValid('tok')).toBeNull();
  });
  test('returns null when email pin mismatches', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ usedAt: null, expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok', 'other@b.co')).toBeNull();
  });
  test('returns invite when valid (no email arg)', async () => {
    const inv = { usedAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.findValid('tok')).toBe(inv);
  });
  test('returns invite when email matches case-insensitively', async () => {
    const inv = { usedAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.findValid('tok', 'A@B.CO')).toBe(inv);
  });
});

describe('InvitationService.assertInvited (signup eligibility resolver)', () => {
  const future = new Date(Date.now() + 3600000);
  test('returns null when no token supplied', async () => {
    expect(await InvitationService.assertInvited({ token: '', email: 'a@b.co' })).toBeNull();
    expect(await InvitationService.assertInvited({})).toBeNull();
  });
  test('returns the resolved invite when token + matching email', async () => {
    const inv = { id: 'i1', usedAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.assertInvited({ token: 'tok', email: 'A@B.CO' })).toBe(inv);
  });
  test('E5: rejects (null) a pinned invite when the signup supplies no email', async () => {
    const inv = { id: 'i2', usedAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.assertInvited({ token: 'tok' })).toBeNull();
    expect(await InvitationService.assertInvited({ token: 'tok', email: '' })).toBeNull();
  });
  test('returns null when the token resolves to no valid invite', async () => {
    InvitationRepository.findByToken.mockResolvedValue(null);
    expect(await InvitationService.assertInvited({ token: 'tok', email: 'a@b.co' })).toBeNull();
  });
});

describe('InvitationService.assertInvitedByEmail (OAuth eligibility resolver)', () => {
  test('returns null when email is falsy', async () => {
    expect(await InvitationService.assertInvitedByEmail({ email: '' })).toBeNull();
    expect(await InvitationService.assertInvitedByEmail({})).toBeNull();
  });
  test('delegates to findValidByEmail (lowercased) when email present', async () => {
    const inv = { id: 'i3', email: 'a@b.co', usedAt: null, expiresAt: new Date(Date.now() + 3600000) };
    InvitationRepository.findByEmail.mockResolvedValue(inv);
    const result = await InvitationService.assertInvitedByEmail({ email: 'A@B.CO' });
    expect(InvitationRepository.findByEmail).toHaveBeenCalledWith('a@b.co');
    expect(result).toBe(inv);
  });
});

describe('InvitationService.create', () => {
  test('lowercases email, generates token + expiry, persists', async () => {
    InvitationRepository.create.mockImplementation((doc) => Promise.resolve({ ...doc, id: '1' }));
    const inv = await InvitationService.create('USER@Example.com', { id: 'admin1' });
    expect(InvitationRepository.create).toHaveBeenCalledTimes(1);
    const arg = InvitationRepository.create.mock.calls[0][0];
    expect(arg.email).toBe('user@example.com');
    expect(arg.token).toMatch(/^[a-f0-9]{40}$/);
    expect(arg.expiresAt instanceof Date).toBe(true);
    expect(arg.invitedBy).toBe('admin1');
    expect(inv.email).toBe('user@example.com');
  });
});

describe('InvitationService.consume', () => {
  test('delegates atomic consume to repository', async () => {
    InvitationRepository.consume.mockResolvedValue({ id: '1', usedAt: new Date() });
    await InvitationService.consume('1');
    expect(InvitationRepository.consume).toHaveBeenCalledWith('1');
  });
});

describe('InvitationService.create — email sending branch', () => {
  test('sends email when mailer is configured', async () => {
    mockMailer.isConfigured.mockReturnValue(true);
    mockMailer.sendMail.mockResolvedValue({});
    InvitationRepository.create.mockImplementation((doc) => Promise.resolve({ ...doc, id: '2' }));
    const inv = await InvitationService.create('user@example.com', { id: 'admin2' });
    expect(inv.email).toBe('user@example.com');
    // sendMail is best-effort (fire-and-forget), not awaited — just verify it was called
    await Promise.resolve(); // flush microtask queue
    expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);
    // reset for other tests
    mockMailer.isConfigured.mockReturnValue(false);
  });
});

describe('InvitationService.findValidByEmail', () => {
  test('returns null when email is falsy', async () => {
    expect(await InvitationService.findValidByEmail('')).toBeNull();
    expect(await InvitationService.findValidByEmail(null)).toBeNull();
  });
  test('delegates to repository when email is provided', async () => {
    const inv = { id: '3', email: 'a@b.co', usedAt: null, expiresAt: new Date(Date.now() + 3600000) };
    InvitationRepository.findByEmail.mockResolvedValue(inv);
    const result = await InvitationService.findValidByEmail('A@B.CO');
    expect(InvitationRepository.findByEmail).toHaveBeenCalledWith('a@b.co');
    expect(result).toBe(inv);
  });
});

describe('InvitationService.list / get / revoke', () => {
  test('list delegates to repository', async () => {
    InvitationRepository.list.mockResolvedValue([]);
    await InvitationService.list();
    expect(InvitationRepository.list).toHaveBeenCalledTimes(1);
  });
  test('get delegates to repository', async () => {
    InvitationRepository.get.mockResolvedValue(null);
    await InvitationService.get('id-1');
    expect(InvitationRepository.get).toHaveBeenCalledWith('id-1');
  });
  test('revoke delegates remove to repository', async () => {
    InvitationRepository.remove.mockResolvedValue({ deletedCount: 1 });
    await InvitationService.revoke('id-1');
    expect(InvitationRepository.remove).toHaveBeenCalledWith('id-1');
  });
});
