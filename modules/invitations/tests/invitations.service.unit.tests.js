import { jest } from '@jest/globals';

jest.unstable_mockModule('../repositories/invitations.repository.js', () => ({
  default: {
    create: jest.fn(),
    findByToken: jest.fn(),
    findByEmail: jest.fn(),
    claim: jest.fn(),
    finalize: jest.fn(),
    release: jest.fn(),
    releaseStaleClaims: jest.fn(),
    list: jest.fn(),
    remove: jest.fn(),
    revoke: jest.fn(),
    get: jest.fn(),
  },
}));

const mockUserService = { findByEmail: jest.fn(), updateById: jest.fn() };
jest.unstable_mockModule('../../users/services/users.service.js', () => ({ default: mockUserService }));

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

const mockAnalytics = { capture: jest.fn() };
jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
  default: mockAnalytics,
}));

const InvitationRepository = (await import('../repositories/invitations.repository.js')).default;
const InvitationService = (await import('../services/invitations.service.js')).default;
// Real events singleton — the service emits on it; we spy to assert the payload.
const invitationEvents = (await import('../lib/events.js')).default;

beforeEach(() => {
  // Default: no stale claims to sweep, no pre-existing user (E9), no outstanding
  // pending invite (the duplicate-pending guard). clearMocks resets calls but NOT
  // mockResolvedValue, so a prior test's findByEmail value would otherwise leak in.
  InvitationRepository.releaseStaleClaims.mockResolvedValue({ modifiedCount: 0 });
  InvitationRepository.findByEmail.mockResolvedValue(undefined);
  mockUserService.findByEmail.mockResolvedValue(null);
  mockUserService.updateById.mockResolvedValue({});
});

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
    InvitationRepository.findByToken.mockResolvedValue({ status: 'pending', usedAt: new Date(), expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok')).toBeNull();
  });
  test('returns null when expired', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ status: 'pending', usedAt: null, expiresAt: new Date(Date.now() - 1000), email: 'a@b.co' });
    expect(await InvitationService.findValid('tok')).toBeNull();
  });
  test('returns null when email pin mismatches', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ status: 'pending', usedAt: null, expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok', 'other@b.co')).toBeNull();
  });
  test('returns invite when valid (no email arg)', async () => {
    const inv = { status: 'pending', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.findValid('tok')).toBe(inv);
  });
  test('returns invite when email matches case-insensitively', async () => {
    const inv = { status: 'pending', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.findValid('tok', 'A@B.CO')).toBe(inv);
  });
  test('E2: a claimed-but-unfinalized invite (consumingAt set, no acceptedAt) is INVISIBLE', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ status: 'pending', usedAt: null, consumingAt: new Date(), acceptedAt: null, expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok', 'a@b.co')).toBeNull();
  });
  test('E8: a revoked invite is INVISIBLE even if otherwise valid', async () => {
    InvitationRepository.findByToken.mockResolvedValue({ status: 'revoked', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValid('tok', 'a@b.co')).toBeNull();
  });
  test('lazily sweeps stale claims before reading', async () => {
    InvitationRepository.findByToken.mockResolvedValue(null);
    await InvitationService.findValid('tok');
    expect(InvitationRepository.releaseStaleClaims).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationService.findValidByEmail (E2 bypass guard)', () => {
  const future = new Date(Date.now() + 3600000);
  test('returns null when email is falsy', async () => {
    expect(await InvitationService.findValidByEmail('')).toBeNull();
  });
  test('resolves a valid pending invite by lowercased email', async () => {
    const inv = { status: 'pending', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByEmail.mockResolvedValue(inv);
    expect(await InvitationService.findValidByEmail('A@B.CO')).toBe(inv);
    expect(InvitationRepository.findByEmail).toHaveBeenCalledWith('a@b.co');
  });
  test('E2: a claimed-but-unfinalized invite is INVISIBLE to findValidByEmail (OAuth bypass blocked)', async () => {
    // Even if the repo handed one back, isUsable re-filters it. Belt + suspenders.
    InvitationRepository.findByEmail.mockResolvedValue({ status: 'pending', usedAt: null, consumingAt: new Date(), acceptedAt: null, expiresAt: future, email: 'a@b.co' });
    expect(await InvitationService.findValidByEmail('a@b.co')).toBeNull();
  });
  test('lazily sweeps stale claims before reading', async () => {
    InvitationRepository.findByEmail.mockResolvedValue(null);
    await InvitationService.findValidByEmail('a@b.co');
    expect(InvitationRepository.releaseStaleClaims).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationService.assertInvited (E5 pin)', () => {
  const future = new Date(Date.now() + 3600000);
  test('returns null when no token supplied', async () => {
    expect(await InvitationService.assertInvited({ token: '', email: 'a@b.co' })).toBeNull();
    expect(await InvitationService.assertInvited({})).toBeNull();
  });
  test('returns the resolved invite when token + matching email', async () => {
    const inv = { id: 'i1', status: 'pending', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' };
    InvitationRepository.findByToken.mockResolvedValue(inv);
    expect(await InvitationService.assertInvited({ token: 'tok', email: 'A@B.CO' })).toBe(inv);
  });
  test('E5: rejects (null) a pinned invite when the signup supplies no email', async () => {
    const inv = { id: 'i2', status: 'pending', usedAt: null, consumingAt: null, expiresAt: future, email: 'a@b.co' };
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
  test('resolves a pending invite by email (lowercased, trimmed) when email present', async () => {
    const inv = { id: 'i3', status: 'pending', email: 'a@b.co', usedAt: null, consumingAt: null, expiresAt: new Date(Date.now() + 3600000) };
    InvitationRepository.findByEmail.mockResolvedValue(inv);
    const result = await InvitationService.assertInvitedByEmail({ email: 'A@B.CO' });
    expect(InvitationRepository.findByEmail).toHaveBeenCalledWith('a@b.co');
    expect(result).toBe(inv);
  });
});

describe('InvitationService.claim (E2 replay guard)', () => {
  test('returns the claimed invite when the repo claim succeeds', async () => {
    const claimed = { id: 'i1', consumingAt: new Date() };
    InvitationRepository.claim.mockResolvedValue(claimed);
    expect(await InvitationService.claim('tok')).toBe(claimed);
    expect(InvitationRepository.claim).toHaveBeenCalledWith('tok');
  });
  test('throws AppError(422) when the invite is no longer claimable (replay / double-accept)', async () => {
    InvitationRepository.claim.mockResolvedValue(null);
    await expect(InvitationService.claim('tok')).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });
});

describe('InvitationService.finalize / release (E2)', () => {
  test('finalize delegates to repo with id + userId and returns the doc', async () => {
    const doc = { id: 'i1', status: 'accepted' };
    InvitationRepository.finalize.mockResolvedValue(doc);
    expect(await InvitationService.finalize('i1', 'u1')).toBe(doc);
    expect(InvitationRepository.finalize).toHaveBeenCalledWith('i1', 'u1');
  });
  test('finalize returns null (logged) when no in-flight claim matched', async () => {
    InvitationRepository.finalize.mockResolvedValue(null);
    expect(await InvitationService.finalize('i1', 'u1')).toBeNull();
  });
  test('release delegates to repo and returns the doc', async () => {
    const doc = { id: 'i1' };
    InvitationRepository.release.mockResolvedValue(doc);
    expect(await InvitationService.release('i1')).toBe(doc);
    expect(InvitationRepository.release).toHaveBeenCalledWith('i1');
  });
});

describe('InvitationService.accept (P8a — referral substrate seam)', () => {
  let emitSpy;
  beforeEach(() => {
    InvitationRepository.finalize.mockResolvedValue({ id: 'i1', status: 'accepted' });
    emitSpy = jest.spyOn(invitationEvents, 'emit');
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  test('finalizes the invite (burns single-use) AND returns the finalized doc', async () => {
    const doc = { id: 'i1', status: 'accepted' };
    InvitationRepository.finalize.mockResolvedValue(doc);
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    expect(await InvitationService.accept(invite, 'u1')).toBe(doc);
    expect(InvitationRepository.finalize).toHaveBeenCalledWith('i1', 'u1');
  });

  test('stamps referredBy = invite.invitedBy on the new user, SERVER-SIDE via updateById', async () => {
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    await InvitationService.accept(invite, 'u1');
    // updateById is the raw path that bypasses the client whitelist + Zod — the ONLY
    // way referredBy is written. Asserts the server sets it from the invite, not a body.
    expect(mockUserService.updateById).toHaveBeenCalledWith('u1', { referredBy: 'inviter1' });
  });

  test('emits invitation.accepted with the documented payload', async () => {
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    await InvitationService.accept(invite, 'u1');
    expect(emitSpy).toHaveBeenCalledWith('invitation.accepted', {
      invitationId: 'i1',
      email: 'a@b.co',
      invitedBy: 'inviter1',
      acceptedUserId: 'u1',
    });
  });

  test('invitedBy null (admin-created invite): SKIPS the referredBy write but STILL emits (invitedBy:null)', async () => {
    const invite = { id: 'i2', email: 'c@d.co', invitedBy: null };
    await InvitationService.accept(invite, 'u2');
    // No inviter → writing null is a redundant no-op, so updateById is skipped.
    expect(mockUserService.updateById).not.toHaveBeenCalled();
    // The event still fires (canonical "invite consumed" signal) with invitedBy:null.
    expect(emitSpy).toHaveBeenCalledWith('invitation.accepted', {
      invitationId: 'i2',
      email: 'c@d.co',
      invitedBy: null,
      acceptedUserId: 'u2',
    });
  });

  test('invitedBy undefined is normalized to null in the payload', async () => {
    const invite = { id: 'i3', email: 'e@f.co' }; // no invitedBy key at all
    await InvitationService.accept(invite, 'u3');
    expect(mockUserService.updateById).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith('invitation.accepted', expect.objectContaining({ invitedBy: null }));
  });

  test('best-effort: a referredBy write failure is swallowed (still emits, still returns the doc)', async () => {
    mockUserService.updateById.mockRejectedValueOnce(new Error('db down'));
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    // Must not throw — the invite is already accepted; signup must not break.
    const result = await InvitationService.accept(invite, 'u1');
    expect(result).toMatchObject({ status: 'accepted' });
    expect(emitSpy).toHaveBeenCalledWith('invitation.accepted', expect.objectContaining({ acceptedUserId: 'u1' }));
  });

  test('best-effort: a synchronous listener throw is caught at the emit site (does not break signup)', async () => {
    const thrower = () => { throw new Error('listener boom'); };
    invitationEvents.on('invitation.accepted', thrower);
    try {
      const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
      await expect(InvitationService.accept(invite, 'u1')).resolves.toMatchObject({ status: 'accepted' });
    } finally {
      invitationEvents.removeListener('invitation.accepted', thrower);
    }
  });

  test('returns null immediately when finalize() returns null — no side-effects fire', async () => {
    // Covers: duplicate-accept / revoked / missing invite → finalize returns null.
    // referredBy must NOT be written and invitation.accepted must NOT be emitted.
    InvitationRepository.finalize.mockResolvedValue(null);
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    const result = await InvitationService.accept(invite, 'u1');
    expect(result).toBeNull();
    expect(mockUserService.updateById).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith('invitation.accepted', expect.anything());
  });

  // #3945: analytics — an accepted invite captures a redemption event.
  test('captures an invitation_redeemed analytics event with invitationId + invitedBy', async () => {
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    await InvitationService.accept(invite, 'u1');
    expect(mockAnalytics.capture).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'invitation_redeemed',
      properties: { invitationId: 'i1', invitedBy: 'inviter1' },
    });
  });

  test('invitedBy null (admin-created invite): invitation_redeemed still fires with invitedBy:null', async () => {
    const invite = { id: 'i2', email: 'c@d.co', invitedBy: null };
    await InvitationService.accept(invite, 'u2');
    expect(mockAnalytics.capture).toHaveBeenCalledWith({
      distinctId: 'u2',
      event: 'invitation_redeemed',
      properties: { invitationId: 'i2', invitedBy: null },
    });
  });

  test('does NOT capture invitation_redeemed when finalize() returns null (no side-effects fire)', async () => {
    InvitationRepository.finalize.mockResolvedValue(null);
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    await InvitationService.accept(invite, 'u1');
    expect(mockAnalytics.capture).not.toHaveBeenCalled();
  });

  test('best-effort: an analytics capture throw is swallowed (still emits, still returns the doc)', async () => {
    mockAnalytics.capture.mockImplementationOnce(() => { throw new Error('analytics boom'); });
    const invite = { id: 'i1', email: 'a@b.co', invitedBy: 'inviter1' };
    const result = await InvitationService.accept(invite, 'u1');
    expect(result).toMatchObject({ status: 'accepted' });
    expect(emitSpy).toHaveBeenCalledWith('invitation.accepted', expect.objectContaining({ acceptedUserId: 'u1' }));
  });
});

describe('InvitationService.sweepStaleClaims (E2)', () => {
  test('computes a cutoff and delegates to releaseStaleClaims', async () => {
    InvitationRepository.releaseStaleClaims.mockResolvedValue({ modifiedCount: 2 });
    await InvitationService.sweepStaleClaims();
    expect(InvitationRepository.releaseStaleClaims).toHaveBeenCalledTimes(1);
    const cutoff = InvitationRepository.releaseStaleClaims.mock.calls.at(-1)[0];
    expect(cutoff instanceof Date).toBe(true);
    expect(cutoff.getTime()).toBeLessThan(Date.now());
  });
  test('never throws — a sweep error is swallowed + logged', async () => {
    InvitationRepository.releaseStaleClaims.mockRejectedValue(new Error('db down'));
    await expect(InvitationService.sweepStaleClaims()).resolves.toBeUndefined();
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

  test('E9: rejects (422) when a user already exists for the email', async () => {
    mockUserService.findByEmail.mockResolvedValue({ id: 'u1', email: 'taken@example.com' });
    await expect(InvitationService.create('Taken@Example.com', { id: 'admin1' })).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
    });
    // checks the lowercased email + never persists an invite for an existing user
    expect(mockUserService.findByEmail).toHaveBeenCalledWith('taken@example.com');
    expect(InvitationRepository.create).not.toHaveBeenCalled();
  });

  test('rejects (409 CONFLICT) when a PENDING invitation already exists for the email', async () => {
    InvitationRepository.findByEmail.mockResolvedValue({ id: 'i0', email: 'dup@example.com', status: 'pending' });
    await expect(InvitationService.create('Dup@Example.com', { id: 'admin1' })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
    // checks the lowercased email + never persists a second live invite
    expect(InvitationRepository.findByEmail).toHaveBeenCalledWith('dup@example.com');
    expect(InvitationRepository.create).not.toHaveBeenCalled();
  });
});

describe('InvitationService.create — #3833 self-invite guard', () => {
  test('rejects 422 "You cannot invite yourself" BEFORE the E9 lookup and any persistence', async () => {
    await expect(InvitationService.create('Me@Example.com', { id: 'u1', email: 'me@example.com' })).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
    });
    await expect(InvitationService.create('me@example.com', { id: 'u1', email: 'me@example.com' })).rejects.toThrow('You cannot invite yourself');
    // Fires before E9: the registered-email lookup is never reached, nothing persists.
    expect(mockUserService.findByEmail).not.toHaveBeenCalled();
    expect(InvitationRepository.create).not.toHaveBeenCalled();
  });
  test('matches case-insensitively and trims whitespace (same normalization both sides)', async () => {
    await expect(InvitationService.create('  ME@EXAMPLE.COM ', { id: 'u1', email: 'Me@Example.com' })).rejects.toMatchObject({ status: 422 });
  });
  test('a different invitee email passes the guard — E9 path unchanged', async () => {
    InvitationRepository.create.mockImplementation((doc) => Promise.resolve({ ...doc, id: '1' }));
    const inv = await InvitationService.create('friend@example.com', { id: 'u1', email: 'me@example.com' });
    expect(inv.email).toBe('friend@example.com');
    expect(mockUserService.findByEmail).toHaveBeenCalledWith('friend@example.com');
  });
  test('an inviter without an email (defensive) skips the guard, E9 still protects', async () => {
    InvitationRepository.create.mockImplementation((doc) => Promise.resolve({ ...doc, id: '2' }));
    const inv = await InvitationService.create('someone@example.com', { id: 'u1' });
    expect(inv.email).toBe('someone@example.com');
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

describe('InvitationService.list / get / revoke', () => {
  test('list(admin) → unscoped repository list (#3833)', async () => {
    InvitationRepository.list.mockResolvedValue([]);
    await InvitationService.list({ id: 'a1', roles: ['user', 'admin'] });
    expect(InvitationRepository.list).toHaveBeenCalledWith();
  });
  test('list(non-admin) → repository list scoped to { invitedBy: <caller id> } (#3833)', async () => {
    InvitationRepository.list.mockResolvedValue([]);
    await InvitationService.list({ id: 'u1', roles: ['user'] });
    expect(InvitationRepository.list).toHaveBeenCalledWith({ invitedBy: 'u1' });
  });
  test('list(non-admin with _id only) → scoped on _id (mirrors create() id resolution)', async () => {
    InvitationRepository.list.mockResolvedValue([]);
    await InvitationService.list({ _id: 'u2', roles: ['user'] });
    expect(InvitationRepository.list).toHaveBeenCalledWith({ invitedBy: 'u2' });
  });
  test('list with no resolvable caller id → empty list, repository untouched (never leaks the invitedBy:null admin rows)', async () => {
    expect(await InvitationService.list(undefined)).toEqual([]);
    expect(await InvitationService.list({ roles: ['user'] })).toEqual([]);
    expect(InvitationRepository.list).not.toHaveBeenCalled();
  });
  test('get delegates to repository', async () => {
    InvitationRepository.get.mockResolvedValue(null);
    await InvitationService.get('id-1');
    expect(InvitationRepository.get).toHaveBeenCalledWith('id-1');
  });
  test('E8: revoke delegates soft-delete to repository.revoke (not remove)', async () => {
    InvitationRepository.revoke.mockResolvedValue({ id: 'id-1', status: 'revoked' });
    await InvitationService.revoke('id-1');
    expect(InvitationRepository.revoke).toHaveBeenCalledWith('id-1');
  });
});

describe('InvitationService.resend', () => {
  const pending = { id: 'i1', email: 'a@b.co', token: 'tok-1', status: 'pending' };
  beforeEach(() => {
    mockMailer.isConfigured.mockReturnValue(true);
    mockMailer.sendMail.mockResolvedValue({});
  });
  afterEach(() => {
    mockMailer.isConfigured.mockReturnValue(false);
  });

  test('re-sends the signup-invite email with the EXISTING token and returns the invitation', async () => {
    InvitationRepository.get.mockResolvedValue(pending);
    const result = await InvitationService.resend('i1');
    expect(result).toBe(pending);
    expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);
    const mail = mockMailer.sendMail.mock.calls[0][0];
    expect(mail.template).toBe('signup-invite');
    expect(mail.to).toBe('a@b.co');
    // No token regeneration: a previously emailed/shared link must stay valid.
    expect(mail.params.url).toBe('http://localhost:3000/signup?inviteToken=tok-1');
  });

  test('404 when the invitation does not exist', async () => {
    InvitationRepository.get.mockResolvedValue(null);
    await expect(InvitationService.resend('missing')).rejects.toMatchObject({ status: 404 });
    expect(mockMailer.sendMail).not.toHaveBeenCalled();
  });

  test('409 when the invitation is not pending (accepted/revoked never re-email)', async () => {
    InvitationRepository.get.mockResolvedValue({ ...pending, status: 'accepted' });
    await expect(InvitationService.resend('i1')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(mockMailer.sendMail).not.toHaveBeenCalled();
  });

  test('422 when the mailer is not configured (resend IS the email — fail loudly)', async () => {
    mockMailer.isConfigured.mockReturnValue(false);
    InvitationRepository.get.mockResolvedValue(pending);
    await expect(InvitationService.resend('i1')).rejects.toMatchObject({ status: 422 });
    expect(mockMailer.sendMail).not.toHaveBeenCalled();
  });

  test('propagates a transport failure as a rejection (resend IS the email — no silent success)', async () => {
    const transportError = new Error('SMTP timeout');
    InvitationRepository.get.mockResolvedValue(pending);
    mockMailer.sendMail.mockRejectedValue(transportError);
    await expect(InvitationService.resend('i1')).rejects.toThrow('SMTP timeout');
  });
});
