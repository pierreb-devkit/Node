/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import organizationsDevConfig from '../../../modules/organizations/config/organizations.development.config.js';
import billingDevConfig from '../../../modules/billing/config/billing.development.config.js';
import authDevConfig from '../../../modules/auth/config/auth.development.config.js';

/**
 * Config-layering regression guard for the rate-limiter env-gate defect.
 *
 * The rate-limiter middleware is presence-driven: `limiters.<name>` returns a real
 * limiter iff `config.rateLimit.<name>` exists in merged config, else a no-op.
 * Previously `rateLimit.api` and `rateLimit.billingPlans` existed ONLY in
 * `config/defaults/production.config.js` (literal `NODE_ENV=production`) and
 * `test.config.js`, so under the downstream run model (NODE_ENV=<project>) they
 * were undefined → no-op → the public Stripe-fanout and membership-request routes
 * ran unthrottled.
 *
 * Fix: each profile lives in its owning module's *.development.config.js — a base
 * (Layer 1) layer that ALWAYS merges regardless of NODE_ENV, mirroring how the
 * `auth` profile is provided. Stricter caps stay as production-config overrides.
 *
 * A base-layer profile is a structural contract; assert its presence + shape so a
 * future refactor that drops it (re-opening the defect) fails loudly.
 */
describe('rate-limiter base-layer profiles (env-gate config-layering):', () => {
  /**
   * Assert a profile is a usable express-rate-limit options object.
   * @param {object} profile - a config.rateLimit.<name> profile
   * @returns {void}
   */
  const expectUsableProfile = (profile) => {
    expect(profile).toBeDefined();
    expect(typeof profile).toBe('object');
    expect(Number.isInteger(profile.windowMs)).toBe(true);
    expect(profile.windowMs).toBeGreaterThan(0);
    expect(Number.isInteger(profile.max)).toBe(true);
    expect(profile.max).toBeGreaterThan(0);
  };

  test('auth profile already lives in the auth base layer (reference pattern)', () => {
    expectUsableProfile(authDevConfig.rateLimit.auth);
  });

  test('api profile lives in the organizations base layer (always merges)', () => {
    expectUsableProfile(organizationsDevConfig.rateLimit.api);
  });

  test('billingPlans profile lives in the billing base layer (always merges)', () => {
    expectUsableProfile(billingDevConfig.rateLimit.billingPlans);
  });
});
