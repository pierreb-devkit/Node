import { jest } from '@jest/globals';

jest.unstable_mockModule('../repositories/auth.invitation.repository.js', () => ({
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
jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
  default: { isConfigured: jest.fn(() => false), sendMail: jest.fn() },
}));

const InvitationRepository = (await import('../repositories/auth.invitation.repository.js')).default;
const InvitationService = (await import('../services/auth.invitation.service.js')).default;

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
