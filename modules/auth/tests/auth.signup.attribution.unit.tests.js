/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests — signup attribution (epic #4002 / #4003).
 * Verifies the local signup handler persists the validated `attribution`
 * object on the created user ONLY when the analytics client is actually
 * configured (`AnalyticsService.isConfigured()` — i.e. the PostHog client
 * initialized, `enabled && key`), strips it otherwise, and flattens it
 * PostHog-style onto the `user_signed_up` capture event. Contract amendment:
 * the gate is `isConfigured()`, NOT `config.analytics?.posthog?.enabled`
 * alone — `enabled:true` with no `key` never initializes the client (see
 * lib/services/analytics.js#init), which would otherwise persist attribution
 * nobody ever reads. Mirrors the mocking pattern in
 * auth.silent.catch.unit.tests.js.
 */

const baseAttribution = {
  referrer: 'https://google.com',
  landingPath: '/pricing',
  utmSource: 'google',
  utmMedium: 'cpc',
  utmCampaign: 'launch',
  utmTerm: 'saas',
  utmContent: 'ad1',
};

/**
 * Wire up every module `auth.controller.js` imports at module scope. `isConfigured`
 * drives the `AnalyticsService.isConfigured()` mock — the actual gate the controller
 * reads. `analyticsConfig` optionally overrides the mocked `config.analytics` shape
 * (independent of `isConfigured`), so a test can prove `enabled:true` alone is no
 * longer sufficient — the client must have actually initialized.
 * @param {boolean} isConfigured - value AnalyticsService.isConfigured() resolves to
 * @param {Object} [analyticsConfig] - override for the mocked config.analytics.posthog shape
 * @returns {Promise<{AuthController: Object, mockCreate: Function, mockCapture: Function, mockIsConfigured: Function}>}
 */
const loadController = async (isConfigured, analyticsConfig) => {
  jest.resetModules();

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  const mockCreate = jest.fn().mockResolvedValue({
    id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local', createdAt: new Date('2026-01-01'),
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
      // Kept in sync with `isConfigured` by default so the config mock stays
      // realistic; tests proving the isConfigured() gate pass an explicit override.
      analytics: analyticsConfig ?? { posthog: { enabled: isConfigured, key: isConfigured ? 'phc_test_key' : undefined } },
    },
  }));

  jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
    default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
  }));

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

  const mockCapture = jest.fn();
  const mockIsConfigured = jest.fn().mockReturnValue(isConfigured);
  jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
    default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: mockCapture, isConfigured: mockIsConfigured },
  }));

  const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

  return { AuthController, mockCreate, mockCapture, mockIsConfigured };
};

describe('auth.controller signup attribution (#4002/#4003):', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('persists attribution on the created user when the analytics client is configured', async () => {
    const { AuthController, mockCreate, mockCapture } = await loadController(true);

    const req = {
      body: {
        email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!',
        attribution: baseAttribution,
      },
      query: {},
    };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createdWith = mockCreate.mock.calls[0][0];
    expect(createdWith.attribution).toEqual(baseAttribution);

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({
      event: 'user_signed_up',
      properties: expect.objectContaining({
        referrer: baseAttribution.referrer,
        landing_path: baseAttribution.landingPath,
        utm_source: baseAttribution.utmSource,
        utm_medium: baseAttribution.utmMedium,
        utm_campaign: baseAttribution.utmCampaign,
        utm_term: baseAttribution.utmTerm,
        utm_content: baseAttribution.utmContent,
      }),
    }));
  });

  test('strips attribution before create when the analytics client is not configured (feature inert)', async () => {
    const { AuthController, mockCreate, mockCapture } = await loadController(false);

    const req = {
      body: {
        email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!',
        attribution: baseAttribution,
      },
      query: {},
    };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createdWith = mockCreate.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(createdWith, 'attribution')).toBe(false);

    // capture() is still called (invite/referral tracking is independent of
    // attribution), but carries none of the flattened attribution keys.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const capturedProperties = mockCapture.mock.calls[0][0].properties;
    for (const key of ['referrer', 'landing_path', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      expect(Object.prototype.hasOwnProperty.call(capturedProperties, key)).toBe(false);
    }
  });

  test('strips attribution when config.analytics.posthog.enabled=true but key is missing (client never initialized)', async () => {
    // Contract amendment regression guard: `enabled:true` with no `key` never sets
    // the PostHog client (lib/services/analytics.js#init), so isConfigured() is
    // false even though the raw config flag reads true. The gate must follow
    // isConfigured(), not the config flag — passed explicitly here since the
    // real init() logic is not under test, only the controller's gate.
    const { AuthController, mockCreate, mockCapture, mockIsConfigured } = await loadController(
      false,
      { posthog: { enabled: true, key: undefined } },
    );

    const req = {
      body: {
        email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!',
        attribution: baseAttribution,
      },
      query: {},
    };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(mockIsConfigured).toHaveBeenCalled();
    const createdWith = mockCreate.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(createdWith, 'attribution')).toBe(false);

    const capturedProperties = mockCapture.mock.calls[0][0].properties;
    expect(Object.prototype.hasOwnProperty.call(capturedProperties, 'utm_source')).toBe(false);
  });

  test('a signup with no attribution submitted creates no attribution field and no flattened keys', async () => {
    const { AuthController, mockCreate, mockCapture } = await loadController(true);

    const req = {
      body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' },
      query: {},
    };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    const createdWith = mockCreate.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(createdWith, 'attribution')).toBe(false);

    const capturedProperties = mockCapture.mock.calls[0][0].properties;
    expect(Object.prototype.hasOwnProperty.call(capturedProperties, 'utm_source')).toBe(false);
  });

  test('only present attribution keys are flattened onto the capture event', async () => {
    const { AuthController, mockCreate, mockCapture } = await loadController(true);

    const req = {
      body: {
        email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!',
        attribution: { utmSource: 'newsletter' },
      },
      query: {},
    };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(mockCreate.mock.calls[0][0].attribution).toEqual({ utmSource: 'newsletter' });

    const capturedProperties = mockCapture.mock.calls[0][0].properties;
    expect(capturedProperties.utm_source).toBe('newsletter');
    for (const key of ['referrer', 'landing_path', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      expect(Object.prototype.hasOwnProperty.call(capturedProperties, key)).toBe(false);
    }
  });
});
