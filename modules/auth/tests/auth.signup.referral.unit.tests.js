/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

import { encodeReferralCode } from '../../users/lib/users.referralCode.js';

/**
 * Unit tests — shareable referral link (#4212) in auth.signup.service.js.
 * `ref` in the signup body names a referrer by an encoded user id. The server
 * resolves it and sets `referredBy`; unknown/invalid codes never fail a signup;
 * an honored invite wins; the feature is gated by `billing.referral.enabled`.
 * No DB, no HTTP: every leaf dependency is mocked.
 */

const REFERRER_ID = '507f1f77bcf86cd799439011';

/**
 * @desc Mock every auth.signup.service dependency and import the service.
 * @param {Object} args
 * @param {boolean} [args.enabled=true] - config.billing.referral.enabled
 * @param {Object} [args.eligibility] - mocked eligibility default export
 * @param {boolean} [args.referrerExists=true] - whether the referrer id resolves to a user
 * @param {boolean} [args.analytics=true] - whether analytics is configured
 * @returns {Promise<Object>} the service plus the spies
 */
async function load({ enabled = true, eligibility, referrerExists = true } = {}) {
  jest.resetModules();
  const create = jest.fn().mockImplementation(async (body) => ({
    id: 'u1', email: body.email, firstName: 'A', lastName: 'B', provider: 'local',
  }));
  const getBrut = jest.fn().mockImplementation(async ({ id }) => (id === REFERRER_ID && !referrerExists ? null : { id }));
  const capture = jest.fn();
  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: {
      sign: { up: true },
      app: { title: 'T', contact: 'c@c.com' },
      billing: { referral: { enabled } },
    },
  }));
  jest.unstable_mockModule('../../users/services/users.service.js', () => ({
    default: {
      create, getBrut, update: jest.fn().mockResolvedValue({}), remove: jest.fn(), count: jest.fn().mockResolvedValue(0),
    },
  }));
  jest.unstable_mockModule('../services/auth.eligibility.js', () => ({
    default: eligibility || { assertSignupEligible: jest.fn().mockResolvedValue(undefined) },
  }));
  jest.unstable_mockModule('../../organizations/services/organizations.service.js', () => ({
    default: { handleSignupOrganization: jest.fn().mockResolvedValue({ organization: null }) },
  }));
  jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
    default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
  }));
  jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
    default: { identify: jest.fn(), capture, isConfigured: jest.fn().mockReturnValue(true) },
  }));
  jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({ default: jest.fn().mockReturnValue('http://localhost') }));
  const { default: SignupService } = await import('../services/auth.signup.service.js');
  return { SignupService, create, getBrut, capture };
}

const body = (extra = {}) => ({ email: 'new@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!', ...extra });
const createdWith = (create) => create.mock.calls[0][0];
const signedUpProps = (capture) => capture.mock.calls.find(([c]) => c.event === 'user_signed_up')[0].properties;

describe('auth.signup.service — referral link (#4212)', () => {
  test('a valid ref sets referredBy server-side and is never persisted as a field', async () => {
    const { SignupService, create, capture } = await load();
    await SignupService.signup({ body: body({ ref: encodeReferralCode(REFERRER_ID) }), query: {} });
    expect(createdWith(create).referredBy).toBe(REFERRER_ID);
    expect(createdWith(create)).not.toHaveProperty('ref');
    expect(signedUpProps(capture)).toMatchObject({ invited: false, referralSource: 'link' });
  });

  test.each([
    ['unknown user', encodeReferralCode(REFERRER_ID), false],
    ['garbage', 'not-a-code!!', true],
    ['wrong length', 'abc', true],
  ])('%s: signup succeeds, no attribution', async (_label, ref, referrerExists) => {
    const { SignupService, create, capture } = await load({ referrerExists });
    const res = await SignupService.signup({ body: body({ ref }), query: {} });
    expect(res.user.id).toBe('u1');
    expect(createdWith(create)).not.toHaveProperty('referredBy');
    expect(createdWith(create)).not.toHaveProperty('ref');
    expect(signedUpProps(capture).referralSource).toBeNull();
  });

  test('a client-sent referredBy is still deleted, even next to a valid ref', async () => {
    const { SignupService, create } = await load();
    await SignupService.signup({ body: body({ referredBy: 'attacker', ref: encodeReferralCode(REFERRER_ID) }), query: {} });
    expect(createdWith(create).referredBy).toBe(REFERRER_ID);
    const second = await load();
    await second.SignupService.signup({ body: body({ referredBy: 'attacker' }), query: {} });
    expect(createdWith(second.create)).not.toHaveProperty('referredBy');
  });

  test('an honored invite wins over ref', async () => {
    const finalize = jest.fn().mockResolvedValue({});
    const eligibility = {
      assertSignupEligible: jest.fn().mockResolvedValue({
        invite: { id: 'inv1', email: 'new@test.com', invitedBy: 'inviter1' }, claimed: true, finalize, release: jest.fn(),
      }),
    };
    const { SignupService, create, capture } = await load({ eligibility });
    await SignupService.signup({ body: body({ ref: encodeReferralCode(REFERRER_ID) }), query: {} });
    expect(createdWith(create)).not.toHaveProperty('referredBy');
    expect(createdWith(create)).not.toHaveProperty('ref');
    expect(finalize).toHaveBeenCalled();
    expect(signedUpProps(capture)).toMatchObject({ invited: true, referralSource: 'invite' });
  });

  test('a presented but NOT claimed invite does not beat ref (unclaimed = not attributed, #3983)', async () => {
    const finalize = jest.fn().mockResolvedValue({});
    const eligibility = {
      assertSignupEligible: jest.fn().mockResolvedValue({
        invite: { id: 'inv1', email: 'new@test.com', invitedBy: 'inviter1' }, claimed: false, finalize, release: jest.fn(),
      }),
    };
    const { SignupService, create, capture } = await load({ eligibility });
    await SignupService.signup({ body: body({ ref: encodeReferralCode(REFERRER_ID) }), query: {} });
    expect(createdWith(create).referredBy).toBe(REFERRER_ID);
    expect(finalize).not.toHaveBeenCalled();
    expect(signedUpProps(capture)).toMatchObject({ invited: false, invitationId: null, referralSource: 'link' });
  });

  test('referral disabled: ref is ignored and stripped', async () => {
    const { SignupService, create, getBrut, capture } = await load({ enabled: false });
    await SignupService.signup({ body: body({ ref: encodeReferralCode(REFERRER_ID) }), query: {} });
    expect(createdWith(create)).not.toHaveProperty('referredBy');
    expect(createdWith(create)).not.toHaveProperty('ref');
    expect(getBrut).not.toHaveBeenCalledWith({ id: REFERRER_ID });
    expect(signedUpProps(capture).referralSource).toBeNull();
  });
});
