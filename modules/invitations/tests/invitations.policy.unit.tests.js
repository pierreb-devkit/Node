import { jest } from '@jest/globals';

// Mutable mock config object — invitationAbilities reads config.invitations?.userFacing
// at CALL time (not import time), so tests toggle this same object reference between
// flag states instead of re-mocking the module per test.
const mockConfig = { invitations: { userFacing: false } };
jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));

const { invitationSubjectRegistration, invitationAbilities } = await import('../policies/invitations.policy.js');

beforeEach(() => {
  mockConfig.invitations.userFacing = false;
});

describe('invitationSubjectRegistration', () => {
  test('registers a single path-subject predicate → Invitation', () => {
    const registerPathSubject = jest.fn();
    invitationSubjectRegistration({ registerPathSubject });
    expect(registerPathSubject).toHaveBeenCalledTimes(1);
    expect(registerPathSubject.mock.calls[0][1]).toBe('Invitation');
  });

  test('predicate matches BOTH the canonical /api/invitations and the /api/auth/invitations alias', () => {
    const registerPathSubject = jest.fn();
    invitationSubjectRegistration({ registerPathSubject });
    const predicate = registerPathSubject.mock.calls[0][0];
    // canonical mount
    expect(predicate('/api/invitations')).toBe(true);
    expect(predicate('/api/invitations/abc')).toBe(true);
    expect(predicate('/api/invitations/verify/tok')).toBe(true);
    // back-compat alias
    expect(predicate('/api/auth/invitations')).toBe(true);
    expect(predicate('/api/auth/invitations/abc')).toBe(true);
    // unrelated paths
    expect(predicate('/api/auth/google')).toBe(false);
    expect(predicate('/api/other')).toBe(false);
  });
});

describe('invitationAbilities', () => {
  test('grants manage all for admin regardless of the userFacing flag (OFF)', () => {
    const can = jest.fn();
    invitationAbilities({ roles: ['admin'] }, null, { can });
    expect(can).toHaveBeenCalledWith('manage', 'all');
    expect(can).toHaveBeenCalledTimes(1);
  });

  test('grants manage all for admin regardless of the userFacing flag (ON)', () => {
    mockConfig.invitations.userFacing = true;
    const can = jest.fn();
    invitationAbilities({ roles: ['admin'] }, null, { can });
    expect(can).toHaveBeenCalledWith('manage', 'all');
    // Admin returns early — never also gets the non-admin create/read grants.
    expect(can).toHaveBeenCalledTimes(1);
  });

  test('userFacing OFF (default): grants nothing for a non-admin', () => {
    const can = jest.fn();
    invitationAbilities({ roles: ['user'] }, null, { can });
    expect(can).not.toHaveBeenCalled();
  });

  test('userFacing OFF (default): grants nothing when roles is absent', () => {
    const can = jest.fn();
    invitationAbilities({}, null, { can });
    expect(can).not.toHaveBeenCalled();
  });

  test('userFacing ON (#3945): grants create + read (type-level) for a non-admin', () => {
    mockConfig.invitations.userFacing = true;
    const can = jest.fn();
    invitationAbilities({ id: 'u1', roles: ['user'] }, null, { can });
    expect(can).toHaveBeenCalledWith('create', 'Invitation');
    expect(can).toHaveBeenCalledWith('read', 'Invitation');
    expect(can).toHaveBeenCalledTimes(2);
  });

  test('userFacing ON: still grants create/read to a user-shaped caller with no roles array', () => {
    mockConfig.invitations.userFacing = true;
    const can = jest.fn();
    invitationAbilities({ id: 'u1' }, null, { can });
    // No roles array → not admin (falls through), but userFacing is ON so the
    // non-admin grant still fires — any caller reaching this function is
    // presumed authenticated by the policy middleware upstream.
    expect(can).toHaveBeenCalledWith('create', 'Invitation');
    expect(can).toHaveBeenCalledWith('read', 'Invitation');
  });

  test('userFacing ON does not grant delete/manage/update to a non-admin (resend/revoke stay out of scope)', () => {
    mockConfig.invitations.userFacing = true;
    const can = jest.fn();
    invitationAbilities({ id: 'u1', roles: ['user'] }, null, { can });
    expect(can).not.toHaveBeenCalledWith('delete', 'Invitation');
    expect(can).not.toHaveBeenCalledWith('manage', expect.anything());
    expect(can).not.toHaveBeenCalledWith('update', 'Invitation');
  });
});
