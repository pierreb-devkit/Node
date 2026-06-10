/**
 * Module dependencies.
 *
 * Unit tests for auth.controller `token` handler.
 * Regression guard: /api/auth/token must include `complementary` in the user
 * projection so per-user UI prefs / extras rehydrate correctly across refresh.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

describe('auth.controller.token — user projection:', () => {
  beforeEach(() => {
    jest.resetModules();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));

    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { getBrut: jest.fn(), update: jest.fn(), create: jest.fn(), remove: jest.fn() },
    }));

    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: { handleSignupOrganization: jest.fn() },
    }));

    jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
      default: { autoSetCurrentOrganization: jest.fn().mockResolvedValue(undefined) },
    }));

    jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
      default: {
        findByUserAndOrganization: jest.fn().mockResolvedValue(null),
        listPendingByUser: jest.fn().mockResolvedValue([]),
      },
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

    jest.unstable_mockModule('../../../modules/users/models/users.schema.js', () => ({
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

    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), groupIdentify: jest.fn() },
    }));

    // Mock the generic eligibility registry (auth.controller imports it, not invitation code)
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
    }));
  });

  test('should include `complementary` in the returned user object (regression guard: per-user UI prefs / extras must rehydrate across refresh)', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = {
      user: {
        id: 'u1',
        provider: 'local',
        roles: ['user'],
        avatar: '',
        email: 'a@b.com',
        lastName: 'Doe',
        firstName: 'Jane',
        additionalProvidersData: {},
        emailVerified: true,
        currentOrganization: null,
        lastLoginAt: new Date(0),
        complementary: { ui: { layout: 'grid' } },
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await AuthController.token(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.user).toBeDefined();
    expect(payload.user.complementary).toEqual({ ui: { layout: 'grid' } });
    // Sanity — existing projection keys still present
    expect(payload.user.id).toBe('u1');
    expect(payload.user.email).toBe('a@b.com');
  });

  test('should preserve a missing/undefined `complementary` as undefined (no crash)', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = {
      user: {
        id: 'u2',
        provider: 'local',
        roles: ['user'],
        avatar: '',
        email: 'c@d.com',
        lastName: 'Smith',
        firstName: 'John',
        additionalProvidersData: {},
        emailVerified: true,
        currentOrganization: null,
        lastLoginAt: new Date(0),
        // complementary intentionally omitted
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await AuthController.token(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.user).toBeDefined();
    expect('complementary' in payload.user).toBe(true);
    expect(payload.user.complementary).toBeUndefined();
  });
});
