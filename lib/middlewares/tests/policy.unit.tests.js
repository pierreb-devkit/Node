/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock logger before importing policy
jest.unstable_mockModule('../../services/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock @casl/ability
jest.unstable_mockModule('@casl/ability', () => ({
  AbilityBuilder: jest.fn().mockImplementation(() => ({
    can: jest.fn(),
    cannot: jest.fn(),
    build: jest.fn().mockReturnValue({ can: jest.fn().mockReturnValue(true) }),
  })),
  Ability: jest.fn(),
  subject: jest.fn((type, doc) => doc),
}));

const { default: logger } = await import('../../services/logger.js');
const { default: policy } = await import('../policy.js');

/**
 * Build absolute path to a test fixture file.
 * @param {string} name - Fixture filename
 * @returns {string} Absolute path to the fixture
 */
const fixture = (name) => path.join(__dirname, 'fixtures', name);

describe('policy discoverPolicies unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should warn when a policy file exports abilities/guestAbilities but no SubjectRegistration', async () => {
    await policy.discoverPolicies([fixture('policy-abilities-only.js')]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exports abilities/guestAbilities but no SubjectRegistration'),
    );
  });

  test('should not warn when a policy file exports both abilities and SubjectRegistration', async () => {
    await policy.discoverPolicies([fixture('policy-with-registration.js')]);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('should not warn when a policy file exports only SubjectRegistration without abilities', async () => {
    await policy.discoverPolicies([fixture('policy-registration-only.js')]);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('should warn when a policy file exports guestAbilities but no SubjectRegistration', async () => {
    await policy.discoverPolicies([fixture('policy-guest-abilities-only.js')]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exports abilities/guestAbilities but no SubjectRegistration'),
    );
  });
});
