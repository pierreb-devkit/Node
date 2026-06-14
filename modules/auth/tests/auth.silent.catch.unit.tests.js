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
          count: jest.fn().mockResolvedValue(0),
        },
      }));

      // auth.controller no longer imports invitation code — it runs the generic
      // eligibility registry. Mock it inert (no checks registered ⇒ no invite stashed).
      jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
        default: {
          registerSignupEligibility: jest.fn(),
          assertSignupEligible: jest.fn().mockResolvedValue(undefined),
          _reset: jest.fn(),
        },
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

      const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: {} };
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

describe('auth.controller signup mass-assignment strip:', () => {
  beforeEach(() => {
    jest.resetModules();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
  });

  test('should scrub server-owned fields and force roles/emailVerified before create', async () => {
    // Defense-in-depth: even if a body reaches the controller carrying server-owned
    // fields (route schema bypassed / future-relaxed), UserService.create — which does
    // NO whitelisting — must receive a scrubbed body. Force roles + emailVerified:false
    // and drop providerData / reset+verification tokens / lockout counters.
    const mockCreate = jest.fn().mockResolvedValue({
      id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local',
    });

    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: {
        create: mockCreate,
        getBrut: jest.fn().mockResolvedValue({ id: 'u1' }),
        update: jest.fn().mockResolvedValue({}),
        remove: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    }));

    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
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

    // Mailer off — signup auto-verifies AFTER create via a separate update; that path
    // does not affect the body handed to create, which is what we assert here.
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: {
        isConfigured: jest.fn().mockReturnValue(false),
        sendMail: jest.fn().mockResolvedValue({ accepted: ['x@y.com'] }),
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
      default: { User: {}, SignupUser: {} },
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
      default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: jest.fn() },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = {
      body: {
        email: 'x@y.com',
        firstName: 'A',
        lastName: 'B',
        password: 'P@ss1234!',
        // Server-owned fields an attacker might inject if validation were bypassed:
        roles: ['admin'],
        emailVerified: true,
        providerData: { sub: 'attacker-sub' },
        additionalProvidersData: { google: { sub: 'attacker-sub' } },
        resetPasswordToken: 'attacker-reset',
        resetPasswordExpires: new Date(),
        emailVerificationToken: 'attacker-verify',
        emailVerificationExpires: new Date(),
        failedLoginAttempts: 99,
        lockUntil: new Date(),
        lastLoginAt: new Date(),
      },
      query: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await AuthController.signup(req, res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createdWith = mockCreate.mock.calls[0][0];
    expect(createdWith.roles).toEqual(['user']);
    expect(createdWith.emailVerified).toBe(false);
    for (const field of [
      'providerData',
      'additionalProvidersData',
      'resetPasswordToken',
      'resetPasswordExpires',
      'emailVerificationToken',
      'emailVerificationExpires',
      'failedLoginAttempts',
      'lockUntil',
      'lastLoginAt',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(createdWith, field)).toBe(false);
    }
    // Legitimate client fields survive
    expect(createdWith.email).toBe('x@y.com');
    expect(createdWith.firstName).toBe('A');
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
        default: { checkPassword: jest.fn().mockReturnValue('NewP@ss1!'), hashPassword: jest.fn().mockResolvedValue('hashed') },
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
