/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for auth.controller getConfig()
 *
 * Verifies that:
 *  1. data.billing is absent in the unauthenticated response.
 *  2. data.billing defaults to { enabled: false, meterMode: false } when
 *     config.billing is undefined (authenticated).
 *  3. data.billing reflects truthful config values when both flags are set
 *     (authenticated).
 */
describe('auth.controller getConfig:', () => {
  let mockConfig;
  let mockResponses;

  beforeEach(() => {
    jest.resetModules();

    mockConfig = {
      sign: { up: true, in: true },
      jwt: { secret: 's', expiresIn: 3600 },
      cookie: { secure: true, sameSite: 'lax' },
      organizations: { enabled: false },
      app: { title: 'Test', contact: 'a@b.com' },
    };

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.invitation.service.js', () => ({
      default: { findValid: jest.fn().mockResolvedValue(null), consume: jest.fn().mockResolvedValue(null) },
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

    // Capture what responses.success is called with
    mockResponses = {
      successCb: jest.fn(),
      errorCb: jest.fn(),
    };
    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn().mockReturnValue(mockResponses.successCb),
        error: jest.fn().mockReturnValue(mockResponses.errorCb),
      },
    }));
  });

  test('data.billing is absent in the unauthenticated response', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = {}; // no req.user
    const res = {};

    await AuthController.getConfig(req, res);

    expect(responses.success).toHaveBeenCalledWith(res, 'Auth config');
    const [data] = mockResponses.successCb.mock.calls[0];
    expect(data.billing).toBeUndefined();
    // sign.cap / sign.remaining must be null when config.sign has no cap (uncapped path)
    expect(data.sign.cap).toBeNull();
    expect(data.sign.remaining).toBeNull();
  });

  test('data.billing defaults to false/false/null when config.billing is undefined (authenticated)', async () => {
    // config has no billing key
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { user: { id: '1' } };
    const res = {};

    await AuthController.getConfig(req, res);

    const [data] = mockResponses.successCb.mock.calls[0];
    expect(data.billing).toBeDefined();
    expect(data.billing.enabled).toBe(false);
    expect(data.billing.meterMode).toBe(false);
    expect(data.billing.equivalences).toBeNull();
  });

  test('data.billing reflects config truthfully when both flags are enabled (authenticated)', async () => {
    mockConfig.billing = { enabled: true, meterMode: true };

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { user: { id: '1' } };
    const res = {};

    await AuthController.getConfig(req, res);

    const [data] = mockResponses.successCb.mock.calls[0];
    expect(data.billing).toBeDefined();
    expect(data.billing.enabled).toBe(true);
    expect(data.billing.meterMode).toBe(true);
    expect(data.billing.equivalences).toBeNull();
  });

  test('data.billing.equivalences is returned verbatim when set in config (authenticated)', async () => {
    const equivalences = {
      plans: {
        growth: { scrapsPerMonth: 200, typicalScrapsPerMonth: 50, features: ['alerts', 'export'] },
        pro: { scrapsPerMonth: 1000, typicalScrapsPerMonth: 200, features: ['alerts', 'export', 'api'] },
      },
    };
    mockConfig.billing = { enabled: true, meterMode: true, equivalences };

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { user: { id: '1' } };
    const res = {};

    await AuthController.getConfig(req, res);

    const [data] = mockResponses.successCb.mock.calls[0];
    expect(data.billing.equivalences).toEqual(equivalences);
  });
});
