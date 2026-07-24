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
        // referredBy is accepted by SignupUser schema (to avoid .strict() 422 on invite
        // paths) but must be stripped by the controller — server owns it via invite finalize.
        referredBy: '64b2f0000000000000000999',
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
      'currentOrganization',
      'referredBy',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(createdWith, field)).toBe(false);
    }
    // Legitimate client fields survive
    expect(createdWith.email).toBe('x@y.com');
    expect(createdWith.firstName).toBe('A');
  });
});

describe('auth.controller signup analytics: invite/referral attribution (#3945):', () => {
  beforeEach(() => {
    jest.resetModules();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
  });

  test('user_signed_up carries invited:true + invitationId + invitedBy when the eligibility registry resolved an invite', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      id: 'u1', email: 'invitee@y.com', firstName: 'A', lastName: 'B', provider: 'local',
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

    // Closed-signup, invite-gated path: the eligibility registry resolves + claims
    // the invite and returns { invite, finalize, release } — auth relays it verbatim.
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue({
          invite: { id: 'inv1', email: 'invitee@y.com', invitedBy: 'inviter1' },
          // closed signup ⇒ the checker claimed it (#3981: auth.controller trusts this
          // flag verbatim rather than re-deriving it from config).
          claimed: true,
          finalize: jest.fn().mockResolvedValue({ id: 'inv1', status: 'accepted' }),
          release: jest.fn(),
        }),
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
        sign: { up: false, in: true }, // closed signup — invite is required to open the gate
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
          this.status = opts?.status;
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

    const mockCapture = jest.fn();
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: mockCapture },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = {
      body: { email: 'invitee@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' },
      query: { inviteToken: 'tok' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await AuthController.signup(req, res);

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u1',
      event: 'user_signed_up',
      properties: expect.objectContaining({
        invited: true,
        invitationId: 'inv1',
        invitedBy: 'inviter1',
      }),
    }));
  });

  test('user_signed_up carries invited:false + null invitationId/invitedBy on a non-invited (open) signup', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      id: 'u2', email: 'self@y.com', firstName: 'C', lastName: 'D', provider: 'local',
    });

    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: {
        create: mockCreate,
        getBrut: jest.fn().mockResolvedValue({ id: 'u2' }),
        update: jest.fn().mockResolvedValue({}),
        remove: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    }));

    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined), // no invite opened the gate
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
        sign: { up: true, in: true }, // open signup — no invite required
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
          this.status = opts?.status;
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

    const mockCapture = jest.fn();
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: mockCapture },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = {
      body: { email: 'self@y.com', firstName: 'C', lastName: 'D', password: 'P@ss1234!' },
      query: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await AuthController.signup(req, res);

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u2',
      event: 'user_signed_up',
      properties: expect.objectContaining({
        invited: false,
        invitationId: null,
        invitedBy: null,
      }),
    }));
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

describe('auth.controller resendVerification mail-transport failure hardening (#3966):', () => {
  let mockError;

  beforeEach(() => {
    jest.resetModules();

    mockError = jest.fn();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: mockError, info: jest.fn() },
    }));
  });

  test('responds with a generic message (never the raw provider error) and still logs the real error server-side', async () => {
    // sendVerificationEmail → mailer.sendMail is awaited directly (not
    // fire-and-forget) and now propagates a transport failure (#3966) instead
    // of swallowing it — the controller catch must not leak this raw string.
    const providerError = new Error('Resend API error: 401 Unauthorized — invalid API key sk_live_abc123');

    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: {
        create: jest.fn(),
        getBrut: jest.fn().mockResolvedValue({ id: 'u1', email: 'x@y.com', emailVerified: false }),
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
      default: { handleSignupOrganization: jest.fn() },
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

    // Mailer configured, sendMail rejects with a raw provider error
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: {
        isConfigured: jest.fn().mockReturnValue(true),
        sendMail: jest.fn().mockRejectedValue(providerError),
      },
    }));

    const successInner = jest.fn();
    const errorInner = jest.fn();
    const success = jest.fn(() => successInner);
    const error = jest.fn(() => errorInner);
    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: { success, error },
    }));

    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn().mockReturnValue(providerError.message) },
    }));

    jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
      default: class AppError extends Error {
        constructor(msg, opts) {
          super(msg);
          this.status = opts?.status;
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
      default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: jest.fn() },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { user: { id: 'u1' } };
    const res = {};

    await AuthController.resendVerification(req, res);

    expect(error).toHaveBeenCalledWith(res, 422, 'Unprocessable Entity', 'Failed to send the email, please try again.');
    const clientMessage = error.mock.calls[0][3];
    expect(clientMessage).not.toContain('sk_live_abc123');
    expect(clientMessage).not.toContain('Resend API error');

    // Real error still logged server-side with context, so it is not lost.
    expect(mockError).toHaveBeenCalledWith('[auth.resendVerification] failed', expect.objectContaining({
      userId: 'u1',
      message: providerError.message,
    }));
  });
});
