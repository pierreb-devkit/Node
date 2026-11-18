/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — `checkOAuthUserProfile` branch 3 (link on verified email).
 * Without a configured mailer, local signup and email change mark any typed
 * email as `emailVerified: true`, so the local flag proves nothing. A
 * provider-verified OAuth sign-in must then never be linked to the existing
 * local account by email: it is rejected like an unverified local account.
 */

/**
 * Load a fresh auth.controller.js with its module-scope imports mocked.
 * @param {Object} options - test options
 * @param {Boolean} options.mailerConfigured - mailer.isConfigured() result
 * @param {Object|null} options.existingUser - local user returned by findByEmail / linkProviderByEmail
 * @returns {Promise<{AuthController: Object, mockLink: Function, mockCreate: Function}>}
 */
const loadController = async ({ mailerConfigured, existingUser }) => {
  jest.resetModules();

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  const mockLink = jest.fn().mockResolvedValue(existingUser?.emailVerified ? existingUser : null);
  const mockCreate = jest.fn().mockResolvedValue({ id: 'new1', email: existingUser?.email });
  jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
    default: {
      create: mockCreate,
      search: jest.fn().mockResolvedValue([]),
      linkProviderByEmail: mockLink,
      findByEmail: jest.fn().mockResolvedValue(existingUser),
      count: jest.fn().mockResolvedValue(0),
    },
  }));

  jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
    default: { registerSignupEligibility: jest.fn(), assertSignupEligible: jest.fn().mockResolvedValue(undefined), _reset: jest.fn() },
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
      sign: { up: true, in: true },
      jwt: { secret: 'test-secret', expiresIn: 3600 },
      cookie: { secure: false, sameSite: 'lax' },
      organizations: { enabled: false },
      app: { title: 'Test', contact: 'test@test.com' },
    },
  }));
  jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
    default: { getResultFromZod: jest.fn((body) => ({ value: { ...body } })), checkError: jest.fn(() => false) },
  }));
  jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
    default: { isConfigured: jest.fn().mockReturnValue(mailerConfigured), sendMail: jest.fn() },
  }));
  jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
    default: { success: jest.fn().mockReturnValue(jest.fn()), error: jest.fn().mockReturnValue(jest.fn()) },
  }));
  jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
    default: { getMessage: jest.fn().mockReturnValue('error') },
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
  return { AuthController, mockLink, mockCreate };
};

const profil = {
  firstName: 'Real',
  lastName: 'Owner',
  email: 'owner@example.com',
  avatar: '',
  providerData: { sub: 'google-sub-1' },
  emailVerifiedByProvider: true,
};

// Local account created without a mailer: auto-marked emailVerified.
const localUser = { id: 'local1', email: 'owner@example.com', provider: 'local', emailVerified: true };

describe('checkOAuthUserProfile — link on verified email depends on the mailer:', () => {
  test('mailer off: does not link a provider identity to an existing local account by email', async () => {
    const { AuthController, mockLink, mockCreate } = await loadController({ mailerConfigured: false, existingUser: localUser });

    await expect(AuthController.checkOAuthUserProfile(profil, 'sub', 'google')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'oAuth, cannot link by email without a mailer',
      description: 'An account with this email already exists. Sign in the way you first signed up.',
    });
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('mailer off, no local account with that email: falls through to account creation', async () => {
    const { AuthController, mockLink, mockCreate } = await loadController({ mailerConfigured: false, existingUser: null });

    const result = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('new1');
  });

  test('mailer on: links a provider identity to a verified local account by email', async () => {
    const { AuthController, mockLink, mockCreate } = await loadController({ mailerConfigured: true, existingUser: localUser });

    const result = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
    expect(mockLink).toHaveBeenCalledWith('owner@example.com', 'google', profil.providerData);
    expect(result).toBe(localUser);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
