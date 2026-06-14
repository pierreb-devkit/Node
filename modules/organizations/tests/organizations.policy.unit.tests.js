/**
 * Unit tests for organizationSubjectRegistration policy guard.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

import { organizationSubjectRegistration } from '../policies/organizations.policy.js';

/**
 * Build a mock subject-registration registry that captures registered resolvers.
 * @returns {{ registerDocumentSubject: jest.Mock, registerPathSubject: jest.Mock, _documentResolvers: Map, _pathResolvers: Array }}
 */
function mockRegistry() {
  const documentResolvers = new Map();
  const pathResolvers = [];
  return {
    registerDocumentSubject: jest.fn((prop, type, guard) => {
      documentResolvers.set(prop, { type, guard });
    }),
    registerPathSubject: jest.fn((routeMatch, subjectType) => {
      pathResolvers.push({ routeMatch, subjectType });
    }),
    _documentResolvers: documentResolvers,
    _pathResolvers: pathResolvers,
  };
}

/**
 * Replicate the production first-match-wins path-subject resolution
 * (see lib/middlewares/policy.js → deriveSubjectType) over the captured resolvers.
 * @param {Array} pathResolvers - Captured { routeMatch, subjectType } entries, in registration order
 * @param {string} routePath - Express route path to resolve
 * @returns {string|null} CASL subject type or null if not mappable
 */
function deriveSubjectType(pathResolvers, routePath) {
  for (const { routeMatch, subjectType } of pathResolvers) {
    if (routeMatch(routePath)) return subjectType;
  }
  return null;
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

  describe('path subject resolution (first-match-wins):', () => {
    let pathResolvers;

    beforeEach(() => {
      const registry = mockRegistry();
      organizationSubjectRegistration(registry);
      pathResolvers = registry._pathResolvers;
    });

    test('should resolve regular /:organizationId/members to the Membership path-subject', () => {
      expect(deriveSubjectType(pathResolvers, '/api/organizations/:organizationId/members')).toBe('Membership');
    });

    test('should resolve admin /:id/members to the Membership path-subject (mirrors the /members carve-out)', () => {
      // The admin path-subject excludes /members so it falls through to the
      // dedicated Membership entry — consistent with the regular /members route
      // and the organization document-subject guard. Without the carve-out the
      // broad admin Organization match would shadow it (first-match-wins).
      expect(deriveSubjectType(pathResolvers, '/api/admin/organizations/:id/members')).toBe('Membership');
    });

    test('should resolve admin organization routes (non-members) to the Organization path-subject', () => {
      expect(deriveSubjectType(pathResolvers, '/api/admin/organizations')).toBe('Organization');
      expect(deriveSubjectType(pathResolvers, '/api/admin/organizations/:id')).toBe('Organization');
    });

    test('should resolve /:organizationId/requests to the Membership path-subject', () => {
      expect(deriveSubjectType(pathResolvers, '/api/organizations/:organizationId/requests')).toBe('Membership');
    });

    test('should resolve plain organization routes to the Organization path-subject', () => {
      expect(deriveSubjectType(pathResolvers, '/api/organizations')).toBe('Organization');
      expect(deriveSubjectType(pathResolvers, '/api/organizations/:id')).toBe('Organization');
    });
  });
});
