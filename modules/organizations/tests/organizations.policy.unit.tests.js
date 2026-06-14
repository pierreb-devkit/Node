/**
 * Unit tests for organizationSubjectRegistration policy guard.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

import { organizationSubjectRegistration } from '../policies/organizations.policy.js';

/**
 * Build a mock subject-registration registry that captures registered resolvers.
 * @returns {{ registerDocumentSubject: jest.Mock, registerPathSubject: jest.Mock, _documentResolvers: Map }}
 */
function mockRegistry() {
  const documentResolvers = new Map();
  return {
    registerDocumentSubject: jest.fn((prop, type, guard) => {
      documentResolvers.set(prop, { type, guard });
    }),
    registerPathSubject: jest.fn(),
    _documentResolvers: documentResolvers,
  };
}

describe('organizationSubjectRegistration policy unit tests:', () => {
  test('should register membershipDoc, organization, and path subjects', () => {
    const registry = mockRegistry();
    organizationSubjectRegistration(registry);

    expect(registry.registerDocumentSubject).toHaveBeenCalledWith('membershipDoc', 'Membership');
    expect(registry.registerDocumentSubject).toHaveBeenCalledWith('organization', 'Organization', expect.any(Function));
    expect(registry.registerPathSubject).toHaveBeenCalledTimes(4);
  });

  describe('organization document subject guard:', () => {
    let guard;

    beforeEach(() => {
      const registry = mockRegistry();
      organizationSubjectRegistration(registry);
      guard = registry._documentResolvers.get('organization').guard;
    });

    test('should return false when req.route is undefined', () => {
      expect(guard({ route: undefined })).toBe(false);
    });

    test('should return false when req.route.path is undefined', () => {
      expect(guard({ route: {} })).toBe(false);
    });

    test('should return false when req.route.path is an empty string', () => {
      expect(guard({ route: { path: '' } })).toBe(false);
    });

    test('should return true for /api/organizations paths', () => {
      expect(guard({ route: { path: '/api/organizations' } })).toBe(true);
      expect(guard({ route: { path: '/api/organizations/:id' } })).toBe(true);
    });

    test('should return true for /api/admin/organizations paths', () => {
      expect(guard({ route: { path: '/api/admin/organizations' } })).toBe(true);
      expect(guard({ route: { path: '/api/admin/organizations/:id' } })).toBe(true);
    });

    test('should still return true for the join-request flow (/:id/requests)', () => {
      // The any-user join-request flow legitimately relies on the Organization
      // subject's unconditional `create` grant — it must NOT be carved out.
      expect(guard({ route: { path: '/api/organizations/:organizationId/requests' } })).toBe(true);
    });

    test('should return false for the /members management routes', () => {
      // /members must authorize via the dedicated Membership path-subject (owner/admin
      // gate), not the unconditional `create Organization` grant — excluding it here
      // prevents the Organization subject from shadowing the Membership subject.
      expect(guard({ route: { path: '/api/organizations/:organizationId/members' } })).toBe(false);
      expect(guard({ route: { path: '/api/organizations/:organizationId/members/:memberId' } })).toBe(false);
      expect(guard({ route: { path: '/api/admin/organizations/:id/members' } })).toBe(false);
    });

    test('should return false for unrelated paths (e.g. billing routes)', () => {
      expect(guard({ route: { path: '/api/billing/plans' } })).toBe(false);
      expect(guard({ route: { path: '/api/tasks' } })).toBe(false);
    });
  });
});
