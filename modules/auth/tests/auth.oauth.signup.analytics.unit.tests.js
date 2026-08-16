/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests — OAuth signup analytics (epic #4002 / #4003).
 * `checkOAuthUserProfile` resolves a user via 4 branches (primary identity,
 * linked identity, link-on-verified-email, create). The `user_signed_up`
 * analytics event must fire ONLY on branch 4 (a brand-new account) — never
 * on branches 1-3, which resolve to an existing/linked user, not a signup.
 * Mirrors the mocking pattern in auth.silent.catch.unit.tests.js.
 */

/**
 * Wire up every module `auth.controller.js` imports at module scope for an
 * OAuth-focused unit test. `searchResults` is an array of successive return
 * values for `UserService.search` (branch 1 then branch 2 lookups).
 * @param {Array<Array>} searchResults - successive UserService.search() results
 * @param {Object} [options] - optional overrides
 * @param {Object|null} [options.linkProviderByEmailResult] - branch-3 linkProviderByEmail() resolution
 * @returns {Promise<{AuthController: Object, mockCreate: Function, mockIdentify: Function, mockCapture: Function, mockSearch: Function}>}
 */
const loadController = async (searchResults, options = {}) => {
  jest.resetModules();

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  const mockSearch = jest.fn();
  searchResults.forEach((result) => mockSearch.mockResolvedValueOnce(result));

  const mockCreate = jest.fn().mockResolvedValue({
    id: 'u9', email: 'newoauth@test.com', firstName: 'New', lastName: 'OAuth', provider: 'google', createdAt: new Date('2026-01-01'),
  });

  jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
    default: {
      create: mockCreate,
      search: mockSearch,
      linkProviderByEmail: jest.fn().mockResolvedValue(options.linkProviderByEmailResult ?? null),
      findByEmail: jest.fn().mockResolvedValue(null),
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

  jest.unstable_mockModule('../../../modules/auth/services/auth.signupCapacity.js', () => ({
    computeSignupCapacity: jest.fn().mockResolvedValue({ cap: null, remaining: null }),
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
      sign: { up: true, in: true }, // open signup — the invite hook is skipped entirely
      jwt: { secret: 'test-secret', expiresIn: 3600 },
      cookie: { secure: false, sameSite: 'lax' },
      organizations: { enabled: false },
      app: { title: 'Test', contact: 'test@test.com' },
    },
  }));

  jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
    default: {
      // Pass the candidate straight through as "validated" — the real Zod
      // schema is not under test here, only the analytics wiring.
      getResultFromZod: jest.fn((body) => ({ value: { ...body } })),
      checkError: jest.fn(() => false),
    },
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

  const mockIdentify = jest.fn();
  const mockCapture = jest.fn();
  jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
    default: { identify: mockIdentify, groupIdentify: jest.fn(), capture: mockCapture },
  }));

  const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

  return { AuthController, mockCreate, mockIdentify, mockCapture, mockSearch };
};

describe('auth.controller checkOAuthUserProfile analytics (#4002/#4003):', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('branch 4 (create): fires identify + user_signed_up with email/plan/createdAt/provider/invited/invitationId/invitedBy', async () => {
    // No match on primary identity, no match on linked identity, no verified
    // email to link on (emailVerifiedByProvider absent) -> falls to branch 4.
    const { AuthController, mockCreate, mockIdentify, mockCapture } = await loadController([[], []]);

    const profil = {
      firstName: 'New', lastName: 'OAuth', email: 'newoauth@test.com', avatar: '',
      providerData: { id: 'google-id-123' },
    };

    const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('u9');

    expect(mockIdentify).toHaveBeenCalledWith('u9', expect.objectContaining({
      email: 'newoauth@test.com', provider: 'google',
    }));
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u9',
      event: 'user_signed_up',
      properties: expect.objectContaining({
        email: 'newoauth@test.com',
        createdAt: expect.any(Date),
        provider: 'google',
        invited: false,
        invitationId: null,
        invitedBy: null,
      }),
    }));
    // plan is present as a key (even though undefined on this stack — no billing module)
    expect(Object.prototype.hasOwnProperty.call(mockCapture.mock.calls[0][0].properties, 'plan')).toBe(true);
  });

  test('branch 1 (existing primary identity match): does NOT fire analytics', async () => {
    const existingUser = { id: 'existing1', email: 'existing@test.com', provider: 'google' };
    const { AuthController, mockCreate, mockIdentify, mockCapture } = await loadController([[existingUser]]);

    const profil = {
      firstName: 'Existing', lastName: 'User', email: 'existing@test.com', avatar: '',
      providerData: { id: 'google-id-999' },
    };

    const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');

    expect(result).toBe(existingUser);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('branch 2 (linked identity match): does NOT fire analytics', async () => {
    const linkedUser = { id: 'linked1', email: 'linked@test.com', provider: 'local' };
    // First search (primary identity) misses, second search (linked identity) hits.
    const { AuthController, mockCreate, mockIdentify, mockCapture } = await loadController([[], [linkedUser]]);

    const profil = {
      firstName: 'Linked', lastName: 'User', email: 'linked@test.com', avatar: '',
      providerData: { id: 'google-id-777' },
    };

    const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');

    expect(result).toBe(linkedUser);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('branch 3 (link on verified email to an existing local account): does NOT fire analytics', async () => {
    const linkedAccount = { id: 'localacct1', email: 'verified@test.com', provider: 'local' };
    // Both search-based lookups (primary, linked) miss, so resolution falls through
    // to the link-on-verified-email branch, which returns a non-null user and
    // returns early — branch 4 (create) must never be reached.
    const { AuthController, mockCreate, mockIdentify, mockCapture } = await loadController(
      [[], []],
      { linkProviderByEmailResult: linkedAccount },
    );

    const profil = {
      firstName: 'Verified', lastName: 'User', email: 'verified@test.com', avatar: '',
      providerData: { id: 'google-id-555' },
      emailVerifiedByProvider: true,
    };

    const result = await AuthController.checkOAuthUserProfile(profil, 'id', 'google');

    expect(result).toBe(linkedAccount);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
