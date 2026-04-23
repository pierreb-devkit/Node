/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests — verify that logger.warn/error is called when fire-and-forget
 * email sends or DB rollback operations fail (replaces silent .catch(() => {})).
 */

describe('auth.controller silent-catch error logging:', () => {
  let mockWarn;
  let mockError;

  beforeEach(() => {
    jest.resetModules();

    mockWarn = jest.fn();
    mockError = jest.fn();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: mockWarn, error: mockError, info: jest.fn() },
    }));
  });

  describe('signup: verification email failure logs a warning', () => {
    test('should call logger.warn when sendVerificationEmail rejects', async () => {
      const emailError = new Error('SMTP down');

      jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
        default: {
          create: jest.fn().mockResolvedValue({
            id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local',
          }),
          getBrut: jest.fn().mockResolvedValue({ id: 'u1' }),
          update: jest.fn().mockResolvedValue({}),
          remove: jest.fn(),
        },
      }));
      jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
        default: { update: jest.fn().mockResolvedValue({}) },
      }));

      jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
        default: {
          handleSignupOrganization: jest.fn().mockResolvedValue({
            organization: null, joined: false, pendingJoin: false,
            abilities: [], organizationSetupRequired: false,
            emailVerificationRequired: false, suggestedOrganization: null,
          }),
        },
      }));

      jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
        default: { autoSetCurrentOrganization: jest.fn() },
      }));

      jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
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

      // Mailer configured, sendMail rejects
      jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
        default: {
          isConfigured: jest.fn().mockReturnValue(true),
          sendMail: jest.fn().mockRejectedValue(emailError),
        },
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

      const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

      const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await AuthController.signup(req, res);

      // Allow the fire-and-forget promise to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(mockWarn).toHaveBeenCalledWith(
        'auth.signup: verification email failed',
        { message: emailError.message, stack: emailError.stack },
      );
    });
  });
});

describe('auth.password.controller silent-catch error logging:', () => {
  let mockWarn;
  let mockError;

  beforeEach(() => {
    jest.resetModules();

    mockWarn = jest.fn();
    mockError = jest.fn();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: mockWarn, error: mockError, info: jest.fn() },
    }));
  });

  describe('reset: confirmation email failure logs a warning', () => {
    test('should call logger.warn when confirmation email rejects', async () => {
      const emailError = new Error('SMTP unavailable');

      jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
        default: {
          getBrut: jest.fn().mockResolvedValue({
            id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B',
            resetPasswordToken: 'tok', resetPasswordExpires: Date.now() + 3600000,
          }),
          update: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B' }),
        },
      }));

      jest.unstable_mockModule('../../../modules/auth/services/auth.service.js', () => ({
        default: { hashPassword: jest.fn().mockResolvedValue('hashed') },
      }));

      // sendMail rejects
      jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
        default: { sendMail: jest.fn().mockRejectedValue(emailError) },
      }));

      jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
        default: jest.fn().mockReturnValue('http://localhost:3000'),
      }));

      jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
        default: { getMessage: jest.fn().mockReturnValue('error') },
      }));

      jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
        default: {
          success: jest.fn().mockReturnValue(jest.fn()),
          error: jest.fn().mockReturnValue(jest.fn()),
        },
      }));

      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          jwt: { secret: 'test-secret', expiresIn: 3600 },
          cookie: { secure: false, sameSite: 'lax' },
          app: { title: 'Test', contact: 'test@test.com' },
        },
      }));

      const { default: PasswordController } = await import('../../../modules/auth/controllers/auth.password.controller.js');

      const req = { body: { token: 'tok', newPassword: 'NewP@ss1!' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await PasswordController.reset(req, res);

      // Allow fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(mockWarn).toHaveBeenCalledWith(
        'auth.password.reset: confirmation email failed',
        { message: emailError.message, stack: emailError.stack },
      );
    });
  });
});
