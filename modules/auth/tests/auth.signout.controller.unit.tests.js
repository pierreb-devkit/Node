/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

describe('auth.controller signout:', () => {
  beforeEach(() => {
    jest.resetModules();

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        sign: { up: true, in: true },
        jwt: { secret: 's', expiresIn: 3600 },
        cookie: { secure: true, sameSite: 'lax' },
        organizations: { enabled: false },
        app: { title: 'Test', contact: 'a@b.com' },
      },
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.invitation.service.js', () => ({
      default: {
        findValid: jest.fn().mockResolvedValue(null),
        findValidByEmail: jest.fn().mockResolvedValue(null),
        consume: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        list: jest.fn(),
        get: jest.fn(),
        revoke: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
      default: { update: jest.fn() },
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
    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));
    jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
      default: jest.fn().mockReturnValue('http://localhost:3000'),
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), groupIdentify: jest.fn() },
    }));
  });

  test('clears TOKEN cookie with options mirroring tokenCookieOptions and returns success', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const cleared = [];
    const res = {
      clearCookie: (name, opts) => { cleared.push({ name, opts }); return res; },
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    AuthController.signout({}, res);

    expect(cleared).toEqual([{ name: 'TOKEN', opts: { httpOnly: true, secure: true, sameSite: 'lax' } }]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ type: 'success', message: 'Signed out' });
  });
});
