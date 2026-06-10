/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for auth.controller verifyEmail() — handleSignupOrganization wiring.
 *
 * Verifies that:
 *  1. verifyEmail calls handleSignupOrganization after the user's emailVerified flag is set.
 *  2. A failure in handleSignupOrganization does NOT cause verifyEmail to fail (best-effort).
 */
describe('auth.controller verifyEmail — handleSignupOrganization wiring:', () => {
  let handleSignupOrganizationMock;
  let mockUserService;
  let mockResponses;

  beforeEach(() => {
    jest.resetModules();

    handleSignupOrganizationMock = jest.fn().mockResolvedValue({ _id: 'org_001' });

    mockUserService = {
      create: jest.fn(),
      getBrut: jest.fn().mockResolvedValue({
        _id: 'user_001',
        id: 'user_001',
        email: 'user@example.com',
        emailVerificationToken: 'tok',
        emailVerificationExpires: Date.now() + 3600000,
      }),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn(),
      search: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    mockResponses = {
      successCb: jest.fn(),
      errorCb: jest.fn(),
    };

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        sign: { up: true, in: true },
        jwt: { secret: 's', expiresIn: 3600 },
        cookie: { secure: false, sameSite: 'lax' },
        organizations: { enabled: true },
        app: { title: 'Test', contact: 'a@b.com' },
      },
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: mockUserService,
    }));
    // auth.controller imports the generic eligibility registry (not invitation code).
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.signupCapacity.js', () => ({
      computeSignupCapacity: jest.fn().mockResolvedValue({ cap: null, remaining: null }),
    }));
    jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
      default: { update: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: { handleSignupOrganization: handleSignupOrganizationMock },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
      default: { autoSetCurrentOrganization: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
      default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
    }));
    jest.unstable_mockModule('../../../modules/users/models/users.schema.js', () => ({
      default: { User: {} },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn().mockReturnValue(mockResponses.successCb),
        error: jest.fn().mockReturnValue(mockResponses.errorCb),
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
    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));
    jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
      default: jest.fn().mockReturnValue('http://localhost:3000'),
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), capture: jest.fn(), groupIdentify: jest.fn() },
    }));
  });

  test('calls handleSignupOrganization when email verification succeeds', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { token: 'tok' } };
    const res = {};

    await AuthController.verifyEmail(req, res);

    expect(handleSignupOrganizationMock).toHaveBeenCalledTimes(1);
    // Must be called with a user that has emailVerified=true (marked before the call)
    expect(handleSignupOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: true }),
    );
  });

  test('does not crash if handleSignupOrganization throws (best-effort)', async () => {
    handleSignupOrganizationMock.mockRejectedValue(new Error('org boom'));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { token: 'tok' } };
    const res = {};

    // Email verification must NOT fail because of an org-setup error
    await AuthController.verifyEmail(req, res);

    // The success response must still be sent
    expect(mockResponses.successCb).toHaveBeenCalledWith({ emailVerified: true });
  });
});
