import { jest } from '@jest/globals';

/**
 * Init unit tests — verify the module plugs into auth at boot:
 *   (a) calling init() once registers exactly one signup-eligibility checker
 *       (init() is intentionally not idempotent — each call appends a checker —
 *       so it must be called exactly once at startup, which this asserts),
 *   (b) it wires an 'error' listener on the invitation events emitter (crash guard),
 *   (c) the registered checker resolves the invite, atomically CLAIMS it (local),
 *       and RETURNS `{ invite, finalize, release }` (the return-value seam — no
 *       stashing) for the local-signup and OAuth paths, honoring E13/E5/E7/E2,
 *   (d) init() runs the boot-time stale-claim sweep (E2 crash recovery).
 *
 * The auth eligibility registry is the REAL module (the integration surface under
 * test); the invitations service is mocked so no DB is touched.
 */

const mockService = {
  assertInvited: jest.fn(),
  assertInvitedByEmail: jest.fn(),
  claim: jest.fn(),
  finalize: jest.fn(),
  accept: jest.fn(),
  release: jest.fn(),
  sweepStaleClaims: jest.fn(),
};
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.unstable_mockModule('../services/invitations.service.js', () => ({ default: mockService }));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));

const Eligibility = (await import('../../auth/services/auth.eligibility.js')).default;
const invitationEvents = (await import('../lib/events.js')).default;
const init = (await import('../invitations.init.js')).default;

beforeEach(async () => {
  jest.clearAllMocks();
  Eligibility._reset();
  invitationEvents.removeAllListeners('error');
  mockService.sweepStaleClaims.mockResolvedValue(undefined);
  mockService.claim.mockResolvedValue({ id: 'claimed' });
  await init();
});

afterEach(() => {
  invitationEvents.removeAllListeners('error');
});

describe('invitations.init', () => {
  test('(a) one init() registers exactly one checker', async () => {
    mockService.assertInvited.mockResolvedValue({ id: 'i1', email: 'a@b.co' });
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledTimes(1);
  });

  test('(b) wires an error listener on the events emitter (no unhandled crash)', () => {
    expect(invitationEvents.listenerCount('error')).toBe(1);
    const err = new Error('boom');
    expect(() => invitationEvents.emit('error', err)).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith('[invitationEvents] uncaught error', { err });
  });

  test('(d) init() runs the boot-time stale-claim sweep (E2 crash recovery)', () => {
    // beforeEach called init() once; the boot sweep must have fired exactly once.
    expect(mockService.sweepStaleClaims).toHaveBeenCalledTimes(1);
  });

  test('(c) closed signup: reads ?inviteToken= (E13), CLAIMS (E2), returns { invite, finalize, release }', async () => {
    const invite = { id: 'i7', email: 'a@b.co' };
    mockService.assertInvited.mockResolvedValue(invite);
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: false });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'tok', email: 'a@b.co' });
    // E2: the resolved invite was atomically claimed by token before returning.
    expect(mockService.claim).toHaveBeenCalledWith('tok');
    expect(result.invite).toBe(invite);
    // returned finalize/release closures bind exactly this invite. P8a: the `finalize`
    // closure routes through accept(invite, userId) (finalize + referral wiring); the
    // closure name is unchanged so auth relays it verbatim. accept receives the WHOLE
    // invite (needs invitedBy/email for referredBy + the event payload), not just the id.
    await result.finalize('u9');
    expect(mockService.accept).toHaveBeenCalledWith(invite, 'u9');
    expect(mockService.finalize).not.toHaveBeenCalled();
    await result.release();
    expect(mockService.release).toHaveBeenCalledWith('i7');
  });

  test('(c) OPEN signup: a presented token is RESOLVED but NOT claimed (preserves P2 gating, E2)', async () => {
    const invite = { id: 'i8', email: 'a@b.co' };
    mockService.assertInvited.mockResolvedValue(invite);
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: true });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'tok', email: 'a@b.co' });
    // Open signup: the invite is presented but not required — it must NOT be claimed
    // (else it would be locked mid-claim, since auth never finalizes on open signup).
    expect(mockService.claim).not.toHaveBeenCalled();
    expect(result.invite).toBe(invite);
  });

  test('(c) local signup: a lost claim race (E2 replay) propagates the 422 throw, blocks signup', async () => {
    mockService.assertInvited.mockResolvedValue({ id: 'i7', email: 'a@b.co' });
    mockService.claim.mockRejectedValue(Object.assign(new Error('gone'), { status: 422, code: 'VALIDATION_ERROR' }));
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    await expect(Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req })).rejects.toMatchObject({ status: 422 });
  });

  test('(c) local signup: no resolved invite ⇒ no claim, no result relayed', async () => {
    mockService.assertInvited.mockResolvedValue(null);
    const req = { query: {}, body: { email: 'a@b.co', inviteToken: 'btok' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'btok', email: 'a@b.co' });
    expect(mockService.claim).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('(c) OAuth: resolves by email only when provider verified it (E7), NO claim, returns { invite, finalize, release }', async () => {
    const invite = { id: 'o1', email: 'v@b.co' };
    mockService.assertInvitedByEmail.mockResolvedValue(invite);
    const result = await Eligibility.assertSignupEligible({ email: 'v@b.co', oauth: { emailVerifiedByProvider: true } });
    expect(mockService.assertInvitedByEmail).toHaveBeenCalledWith({ email: 'v@b.co' });
    // OAuth has no token to claim — claim must NOT be invoked on this path.
    expect(mockService.claim).not.toHaveBeenCalled();
    expect(result.invite).toBe(invite);
    // P8a: the OAuth path's finalize closure also routes through accept — so an
    // OAuth-invited user gets referredBy set + invitation.accepted emitted too.
    await result.finalize('u2');
    expect(mockService.accept).toHaveBeenCalledWith(invite, 'u2');
  });

  test('(c) OAuth: does NOT resolve an invite when the provider email is unverified (E7)', async () => {
    const result = await Eligibility.assertSignupEligible({ email: 'v@b.co', oauth: { emailVerifiedByProvider: false } });
    expect(mockService.assertInvitedByEmail).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('(c) returns null (no result) when ctx carries no carrier on the local path (defensive)', async () => {
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co' });
    expect(result).toBeNull();
    expect(mockService.assertInvited).not.toHaveBeenCalled();
    expect(mockService.assertInvitedByEmail).not.toHaveBeenCalled();
  });
});
