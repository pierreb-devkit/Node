import { jest } from '@jest/globals';

/**
 * #3981 — the local-signup checker in invitations.init.js must atomically CLAIM a
 * resolved invite not only when signup is closed (the invite was required) but ALSO
 * when signup is OPEN and `config.invitations.userFacing` is true (the open-signup
 * hole: a presented token should still convert on a userFacing deployment). Config is
 * mocked here (unlike the sibling invitations.init.unit.tests.js, which relies on the
 * real config's `userFacing: false` default) so both flag states can be asserted.
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
const mockConfig = { invitations: { userFacing: false } };

jest.unstable_mockModule('../services/invitations.service.js', () => ({ default: mockService }));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));

const Eligibility = (await import('../../auth/services/auth.eligibility.js')).default;
const init = (await import('../invitations.init.js')).default;

beforeEach(async () => {
  jest.clearAllMocks();
  Eligibility._reset();
  mockConfig.invitations.userFacing = false;
  mockService.sweepStaleClaims.mockResolvedValue(undefined);
  mockService.claim.mockResolvedValue({ id: 'claimed' });
  await init();
});

describe('invitations.init — userFacing open-signup claim (#3981)', () => {
  test('open signup + userFacing:false (default) ⇒ still NOT claimed (unchanged from pre-#3981), result.claimed is false', async () => {
    mockService.assertInvited.mockResolvedValue({ id: 'i1', email: 'a@b.co' });
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: true });
    expect(mockService.claim).not.toHaveBeenCalled();
    expect(result.invite).toEqual({ id: 'i1', email: 'a@b.co' });
    expect(result.claimed).toBe(false);
  });

  test('open signup + userFacing:true ⇒ CLAIMED (#3981 fix), result.claimed is true (auth.controller trusts this, not config)', async () => {
    mockConfig.invitations.userFacing = true;
    mockService.assertInvited.mockResolvedValue({ id: 'i2', email: 'a@b.co' });
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: true });
    expect(mockService.claim).toHaveBeenCalledWith('tok');
    expect(result.invite).toEqual({ id: 'i2', email: 'a@b.co' });
    expect(result.claimed).toBe(true);
  });

  test('closed signup + userFacing:true ⇒ still CLAIMED (flag is a no-op when signup is closed, invite already required)', async () => {
    mockConfig.invitations.userFacing = true;
    mockService.assertInvited.mockResolvedValue({ id: 'i3', email: 'a@b.co' });
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: false });
    expect(mockService.claim).toHaveBeenCalledWith('tok');
    expect(result.claimed).toBe(true);
  });

  test('open signup + userFacing:true + no invite resolved (no/invalid token) ⇒ no claim, nothing relayed', async () => {
    mockConfig.invitations.userFacing = true;
    mockService.assertInvited.mockResolvedValue(null);
    const req = { query: {}, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: true });
    expect(mockService.claim).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('open signup + userFacing:true ⇒ claimed invite still relays finalize()/release() closures routed through accept()/release()', async () => {
    mockConfig.invitations.userFacing = true;
    const invite = { id: 'i4', email: 'a@b.co' };
    mockService.assertInvited.mockResolvedValue(invite);
    const req = { query: { inviteToken: 'tok' }, body: { email: 'a@b.co' } };
    const result = await Eligibility.assertSignupEligible({ email: 'a@b.co', body: req.body, req, signupOpen: true });
    await result.finalize('u1');
    expect(mockService.accept).toHaveBeenCalledWith(invite, 'u1');
    await result.release();
    expect(mockService.release).toHaveBeenCalledWith('i4');
  });
});
