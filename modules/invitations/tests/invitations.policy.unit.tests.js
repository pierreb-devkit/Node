import { jest } from '@jest/globals';

const { invitationSubjectRegistration, invitationAbilities } = await import('../policies/invitations.policy.js');

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
  test('grants manage all for admin', () => {
    const can = jest.fn();
    invitationAbilities({ roles: ['admin'] }, null, { can });
    expect(can).toHaveBeenCalledWith('manage', 'all');
  });
  test('grants nothing for non-admin', () => {
    const can = jest.fn();
    invitationAbilities({ roles: ['user'] }, null, { can });
    expect(can).not.toHaveBeenCalled();
  });
  test('grants nothing when roles is absent', () => {
    const can = jest.fn();
    invitationAbilities({}, null, { can });
    expect(can).not.toHaveBeenCalled();
  });
});
