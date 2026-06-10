import { jest } from '@jest/globals';

/**
 * Init unit tests — verify the module plugs into auth at boot:
 *   (a) it registers exactly one signup-eligibility checker (via the auth registry),
 *   (b) it wires an 'error' listener on the invitation events emitter (crash guard),
 *   (c) the registered checker resolves + stashes the invite (+ consume closure) on
 *       the ctx carrier for the local-signup and OAuth paths, honoring E13/E5/E7.
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
  test('(a) registers exactly one signup-eligibility checker', async () => {
    // A second init would register a second checker; _reset in beforeEach keeps it at one.
    // Probe indirectly: with the service stubbed to resolve an invite, a single run stashes once.
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

  test('(c) local signup: reads ?inviteToken= (E13) and stashes invite + consume closure', async () => {
    const invite = { id: 'i7', email: 'a@b.co' };
    mockService.assertInvited.mockResolvedValue(invite);
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'tok', email: 'a@b.co' });
    expect(req._signupInvite).toBe(invite);
    // consume closure burns exactly this invite id
    await req._consumeSignupInvite();
    expect(mockService.consume).toHaveBeenCalledWith('i7');
  });

  test('(c) local signup: falls back to body.inviteToken when no query token', async () => {
    mockService.assertInvited.mockResolvedValue(null);
    const req = { query: {}, body: { email: 'a@b.co', inviteToken: 'btok' } };
    await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req });
    expect(mockService.assertInvited).toHaveBeenCalledWith({ token: 'btok', email: 'a@b.co' });
    expect(req._signupInvite).toBeNull();
    expect(req._consumeSignupInvite).toBeNull();
  });

  test('(c) OAuth: resolves by email only when provider verified it (E7)', async () => {
    const invite = { id: 'o1', email: 'v@b.co' };
    mockService.assertInvitedByEmail.mockResolvedValue(invite);
    const carrier = {};
    await Eligibility.assertSignupEligible({ email: 'v@b.co', req: carrier, oauth: { emailVerifiedByProvider: true } });
    expect(mockService.assertInvitedByEmail).toHaveBeenCalledWith({ email: 'v@b.co' });
    expect(carrier._signupInvite).toBe(invite);
  });

  test('(c) OAuth: does NOT resolve an invite when the provider email is unverified (E7)', async () => {
    const carrier = {};
    await Eligibility.assertSignupEligible({ email: 'v@b.co', req: carrier, oauth: { emailVerifiedByProvider: false } });
    expect(mockService.assertInvitedByEmail).not.toHaveBeenCalled();
    expect(carrier._signupInvite).toBeNull();
    expect(carrier._consumeSignupInvite).toBeNull();
  });

  test('(c) is a no-op when ctx carries no carrier (defensive)', async () => {
    await expect(Eligibility.assertSignupEligible({ email: 'a@b.co' })).resolves.toBeUndefined();
    expect(mockService.assertInvited).not.toHaveBeenCalled();
    expect(mockService.assertInvitedByEmail).not.toHaveBeenCalled();
  });
});
