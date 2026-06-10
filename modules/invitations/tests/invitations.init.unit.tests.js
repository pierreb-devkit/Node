import { jest } from '@jest/globals';

/**
 * Init unit tests — verify the module plugs into auth at boot:
 *   (a) calling init() once registers exactly one signup-eligibility checker
 *       (init() is intentionally not idempotent — each call appends a checker —
 *       so it must be called exactly once at startup, which this asserts),
 *   (b) it wires an 'error' listener on the invitation events emitter (crash guard),
 *   (c) the registered checker resolves the invite and RETURNS `{ invite, consume }`
 *       (the return-value seam — no stashing) for the local-signup and OAuth paths,
 *       honoring E13/E5/E7.
 *
 * The auth eligibility registry is the REAL module (the integration surface under
 * test); the invitations service is mocked so no DB is touched.
 */

const mockService = {
  assertInvited: jest.fn(),
  assertInvitedByEmail: jest.fn(),
  consume: jest.fn(),
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
  await init();
});

afterEach(() => {
  invitationEvents.removeAllListeners('error');
});

describe('invitations.init', () => {
  test('(a) one init() registers exactly one checker', async () => {
    // beforeEach ran _reset() then init() once. If init had registered the checker
    // more than once, a SINGLE assertSignupEligible would run it >1× (assertInvited
    // called >1×). One resolver call ⇒ exactly one checker registered per init().
    // (init() is intentionally not idempotent — each call appends a checker — so the
    // module is wired exactly once at boot via a single init(), which this asserts.)
    mockService.assertInvited.mockResolvedValue({ id: 'i1', email: 'a@b.co' });
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledTimes(1);
  });

  test('(b) wires an error listener on the events emitter (no unhandled crash)', () => {
    expect(invitationEvents.listenerCount('error')).toBe(1);
    const err = new Error('boom');
    // Without a listener Node would throw here; with the listener it logs instead.
    expect(() => invitationEvents.emit('error', err)).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith('[invitationEvents] uncaught error', { err });
  });

  test('(c) local signup: reads ?inviteToken= (E13) and returns { invite, consume }', async () => {
    const invite = { id: 'i7', email: 'a@b.co' };
    mockService.assertInvited.mockResolvedValue(invite);
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'tok', email: 'a@b.co' });
    expect(result.invite).toBe(invite);
    // returned consume closure burns exactly this invite id
    await result.consume();
    expect(mockService.consume).toHaveBeenCalledWith('i7');
  });

  test('(c) checker honors a body token when called directly (HTTP signup strips it — query is the real source)', async () => {
    // On the real HTTP signup path the model middleware strips unknown body keys
    // (incl. inviteToken) BEFORE this checker runs, so query is the effective source.
    // This asserts only the checker's isolated contract: when invoked directly (non-HTTP /
    // future-whitelisted callers) with a body token and no query token, it reads the body.
    mockService.assertInvited.mockResolvedValue(null);
    const req = { query: {}, body: { email: 'a@b.co', inviteToken: 'btok' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'btok', email: 'a@b.co' });
    expect(result).toBeNull(); // no eligible invite ⇒ no result relayed to auth
  });

  test('(c) OAuth: resolves by email only when provider verified it (E7), returns { invite, consume }', async () => {
    const invite = { id: 'o1', email: 'v@b.co' };
    mockService.assertInvitedByEmail.mockResolvedValue(invite);
    const result = await Eligibility.assertSignupEligible({ email: 'v@b.co', oauth: { emailVerifiedByProvider: true } });
    expect(mockService.assertInvitedByEmail).toHaveBeenCalledWith({ email: 'v@b.co' });
    expect(result.invite).toBe(invite);
    await result.consume();
    expect(mockService.consume).toHaveBeenCalledWith('o1');
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
