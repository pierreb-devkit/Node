/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics identify / groupIdentify calls on auth and org events.
 */

describe('Analytics identify on auth events:', () => {
  let mockIdentify;
  let mockGroupIdentify;

  beforeEach(() => {
    jest.resetModules();

    mockIdentify = jest.fn();
    mockGroupIdentify = jest.fn();

    jest.unstable_mockModule('../../analytics/services/analytics.service.js', () => ({
      default: {
        identify: mockIdentify,
        groupIdentify: mockGroupIdentify,
        track: jest.fn(),
        init: jest.fn(),
        shutdown: jest.fn(),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('signup', () => {
    const setupSignupMocks = (mockUser) => {
      jest.unstable_mockModule('../../users/services/users.service.js', () => ({
        default: {
          create: jest.fn().mockResolvedValue(mockUser),
          getBrut: jest.fn().mockResolvedValue({ ...mockUser }),
          update: jest.fn().mockResolvedValue(mockUser),
          remove: jest.fn(),
        },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.service.js', () => ({
        default: {
          handleSignupOrganization: jest.fn().mockResolvedValue({
            organization: null,
            joined: false,
            pendingJoin: false,
            abilities: [],
            organizationSetupRequired: false,
            emailVerificationRequired: false,
            suggestedOrganization: null,
          }),
        },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
        default: { autoSetCurrentOrganization: jest.fn() },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
        default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
      }));

      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sign: { up: true, in: true },
          jwt: { secret: 'test-secret', expiresIn: 3600 },
          cookie: { secure: false, sameSite: 'lax' },
          organizations: { enabled: false },
          app: { title: 'Test', contact: 'test@test.com' },
        },
      }));

      jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
        default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
      }));

      jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
        default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
      }));

      jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
        default: {
          success: jest.fn().mockReturnValue(jest.fn()),
          error: jest.fn().mockReturnValue(jest.fn()),
        },
      }));

      jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
        default: { getMessage: jest.fn().mockReturnValue('error') },
      }));

      jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
        default: class AppError extends Error {
          constructor(msg, opts) {
            super(msg);
            this.code = opts?.code;
            this.details = opts?.details;
          }
        },
      }));

      jest.unstable_mockModule('../../users/models/users.schema.js', () => ({
        default: { User: {} },
      }));

      jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
        default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
      }));

      jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
        default: jest.fn().mockReturnValue([]),
      }));

      jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
        default: jest.fn().mockReturnValue('http://localhost:3000'),
      }));
    };

    test('should call AnalyticsService.identify after successful signup', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        provider: 'local',
      };
      setupSignupMocks(mockUser);

      const { default: AuthController } = await import('../../auth/controllers/auth.controller.js');

      const req = { body: { email: 'test@example.com', firstName: 'John', lastName: 'Doe', password: 'StrongPass1!' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await AuthController.signup(req, res);

      expect(mockIdentify).toHaveBeenCalledWith('user-123', {
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        provider: 'local',
      });
    });

    test('should not break signup if AnalyticsService.identify throws', async () => {
      mockIdentify.mockImplementation(() => { throw new Error('PostHog down'); });

      const mockUser = {
        id: 'user-456',
        email: 'fail@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        provider: 'local',
      };
      setupSignupMocks(mockUser);

      const { default: AuthController } = await import('../../auth/controllers/auth.controller.js');

      const req = { body: { email: 'fail@example.com', firstName: 'Jane', lastName: 'Doe', password: 'StrongPass1!' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await AuthController.signup(req, res);

      // Signup should still succeed
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('signin', () => {
    test('should call AnalyticsService.identify after successful signin', async () => {
      const mockUser = {
        id: 'user-789',
        _id: 'user-789',
        email: 'login@example.com',
        firstName: 'Bob',
        lastName: 'Smith',
        lastLoginAt: new Date('2026-01-01'),
        currentOrganization: null,
      };

      jest.unstable_mockModule('../../users/services/users.service.js', () => ({
        default: { getBrut: jest.fn(), update: jest.fn() },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.service.js', () => ({
        default: { handleSignupOrganization: jest.fn() },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
        default: { autoSetCurrentOrganization: jest.fn() },
      }));

      jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
        default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
      }));

      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sign: { up: true, in: true },
          jwt: { secret: 'test-secret', expiresIn: 3600 },
          cookie: { secure: false, sameSite: 'lax' },
          organizations: { enabled: false },
        },
      }));

      jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
        default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
      }));

      jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
        default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
      }));

      jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
        default: {
          success: jest.fn().mockReturnValue(jest.fn()),
          error: jest.fn().mockReturnValue(jest.fn()),
        },
      }));

      jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
        default: { getMessage: jest.fn().mockReturnValue('error') },
      }));

      jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
        default: class AppError extends Error {
          constructor(msg, opts) {
            super(msg);
            this.code = opts?.code;
            this.details = opts?.details;
          }
        },
      }));

      jest.unstable_mockModule('../../users/models/users.schema.js', () => ({
        default: { User: {} },
      }));

      jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
        default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
      }));

      jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
        default: jest.fn().mockReturnValue([]),
      }));

      jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
        default: jest.fn().mockReturnValue('http://localhost:3000'),
      }));

      const { default: AuthController } = await import('../../auth/controllers/auth.controller.js');

      const req = { user: mockUser };
      const res = {
        status: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await AuthController.signin(req, res);

      expect(mockIdentify).toHaveBeenCalledWith('user-789', {
        email: 'login@example.com',
        firstName: 'Bob',
        lastName: 'Smith',
        lastLoginAt: new Date('2026-01-01'),
      });
    });
  });
});

describe('Analytics groupIdentify on organization events:', () => {
  let mockGroupIdentify;

  beforeEach(() => {
    jest.resetModules();

    mockGroupIdentify = jest.fn();

    jest.unstable_mockModule('../../analytics/services/analytics.service.js', () => ({
      default: {
        identify: jest.fn(),
        groupIdentify: mockGroupIdentify,
        track: jest.fn(),
        init: jest.fn(),
        shutdown: jest.fn(),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const setupOrgMocks = (mockOrg) => {
    jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
      default: {
        create: jest.fn().mockResolvedValue(mockOrg),
        update: jest.fn().mockResolvedValue(mockOrg),
        get: jest.fn(),
        listByUser: jest.fn(),
        list: jest.fn(),
        searchByDomain: jest.fn(),
        switchOrganization: jest.fn(),
        remove: jest.fn(),
        autoSetCurrentOrganization: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
      default: {
        findByUserAndOrganization: jest.fn(),
        listByUser: jest.fn(),
        aggregateCountByOrganizations: jest.fn(),
        leave: jest.fn(),
        listPendingByUser: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn().mockReturnValue('error') },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: (res, msg) => (data) => res.json({ type: 'success', message: msg, data }),
        error: jest.fn().mockReturnValue(jest.fn()),
      },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        jwt: { secret: 'test-secret', expiresIn: 3600 },
        cookie: { secure: false, sameSite: 'lax' },
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
    }));

    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));

    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false) },
    }));
  };

  test('should call groupIdentify after org create', async () => {
    const mockOrg = { _id: 'org-1', id: 'org-1', name: 'Acme Corp', createdAt: new Date('2026-01-15') };
    setupOrgMocks(mockOrg);

    const { default: OrgController } = await import('../../organizations/controllers/organizations.controller.js');

    const req = { body: { name: 'Acme Corp' }, user: { _id: 'user-1', id: 'user-1' } };
    const res = { json: jest.fn() };

    await OrgController.create(req, res);

    expect(mockGroupIdentify).toHaveBeenCalledWith('company', 'org-1', {
      name: 'Acme Corp',
      createdAt: new Date('2026-01-15'),
    });
  });

  test('should call groupIdentify after org update', async () => {
    const mockOrg = { _id: 'org-2', id: 'org-2', name: 'Updated Corp' };
    setupOrgMocks(mockOrg);

    const { default: OrgController } = await import('../../organizations/controllers/organizations.controller.js');

    const req = {
      organization: { _id: 'org-2', id: 'org-2', name: 'Old Corp' },
      body: { name: 'Updated Corp' },
    };
    const res = { json: jest.fn() };

    await OrgController.update(req, res);

    expect(mockGroupIdentify).toHaveBeenCalledWith('company', 'org-2', {
      name: 'Updated Corp',
    });
  });

  test('should not break org create if groupIdentify throws', async () => {
    mockGroupIdentify.mockImplementation(() => { throw new Error('PostHog down'); });

    const mockOrg = { _id: 'org-3', id: 'org-3', name: 'Safe Corp', createdAt: new Date() };
    setupOrgMocks(mockOrg);

    const { default: OrgController } = await import('../../organizations/controllers/organizations.controller.js');

    const req = { body: { name: 'Safe Corp' }, user: { _id: 'user-1', id: 'user-1' } };
    const res = { json: jest.fn() };

    await OrgController.create(req, res);

    // Should still return success
    expect(res.json).toHaveBeenCalled();
  });

  test('should not break org update if groupIdentify throws', async () => {
    mockGroupIdentify.mockImplementation(() => { throw new Error('PostHog down'); });

    const mockOrg = { _id: 'org-4', id: 'org-4', name: 'Safe Update Corp' };
    setupOrgMocks(mockOrg);

    const { default: OrgController } = await import('../../organizations/controllers/organizations.controller.js');

    const req = {
      organization: { _id: 'org-4', id: 'org-4', name: 'Old Corp' },
      body: { name: 'Safe Update Corp' },
    };
    const res = { json: jest.fn() };

    await OrgController.update(req, res);

    expect(res.json).toHaveBeenCalled();
  });
});

describe('Analytics groupIdentify on billing plan.changed event:', () => {
  let mockGroupIdentify;
  let billingEvents;

  beforeEach(async () => {
    jest.resetModules();

    mockGroupIdentify = jest.fn();

    jest.unstable_mockModule('../services/analytics.service.js', () => ({
      default: {
        identify: jest.fn(),
        groupIdentify: mockGroupIdentify,
        track: jest.fn(),
        init: jest.fn(),
        shutdown: jest.fn(),
      },
    }));

    // Import the real billing events emitter
    const eventsModule = await import('../../billing/lib/events.js');
    billingEvents = eventsModule.default;
  });

  afterEach(() => {
    billingEvents.removeAllListeners('plan.changed');
    jest.restoreAllMocks();
  });

  test('should call groupIdentify when plan.changed fires', async () => {
    const { default: initAnalytics } = await import('../analytics.init.js');

    const mockApp = { use: jest.fn() };
    initAnalytics(mockApp);

    billingEvents.emit('plan.changed', {
      organizationId: 'org-billing-1',
      previousPlan: 'free',
      newPlan: 'pro',
      isDowngrade: false,
    });

    expect(mockGroupIdentify).toHaveBeenCalledWith('company', 'org-billing-1', { plan: 'pro' });
  });

  test('should not throw when groupIdentify fails on plan.changed', async () => {
    mockGroupIdentify.mockImplementation(() => { throw new Error('PostHog down'); });

    const { default: initAnalytics } = await import('../analytics.init.js');

    const mockApp = { use: jest.fn() };
    initAnalytics(mockApp);

    // Should not throw
    expect(() => {
      billingEvents.emit('plan.changed', {
        organizationId: 'org-billing-2',
        previousPlan: 'pro',
        newPlan: 'free',
        isDowngrade: true,
      });
    }).not.toThrow();
  });
});
