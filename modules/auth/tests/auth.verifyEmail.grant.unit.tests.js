/**
 * Unit tests — verifyEmail provisions the org (and its signup grant) after a
 * successful email verification, via OrganizationsService.handleSignupOrganization(user).
 * Provisioning failure must stay non-fatal: verifyEmail still returns success.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

describe('verifyEmail — org provisioning after email verification (non-fatal):', () => {
  let verifyEmail;
  let mockUserService;
  let mockOrganizationsService;

  const fakeUser = {
    id: '507f1f77bcf86cd799439011',
    _id: '507f1f77bcf86cd799439011',
    email: 'alice@acme.com',
    firstName: 'Alice',
    lastName: 'Smith',
    emailVerificationToken: 'tok_abc',
    emailVerificationExpires: Date.now() + 3600000,
    emailVerified: false,
  };

  const makeReq = (token = 'tok_abc') => ({ params: { token } });
  const makeRes = () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    return { status, json, send: jest.fn() };
  };

  beforeEach(async () => {
    jest.resetModules();

    mockUserService = {
      getBrut: jest.fn().mockResolvedValue({ ...fakeUser }),
      update: jest.fn().mockResolvedValue({}),
    };

    mockOrganizationsService = {
      handleSignupOrganization: jest.fn().mockResolvedValue({
        organization: { _id: 'org_abc' },
        membership: { _id: 'mem_abc' },
        abilities: [],
      }),
    };

    jest.unstable_mockModule('../../users/services/users.service.js', () => ({
      default: mockUserService,
    }));

    jest.unstable_mockModule('../../organizations/services/organizations.service.js', () => ({
      default: mockOrganizationsService,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn(() => jest.fn().mockReturnValue(undefined)),
        error: jest.fn(() => jest.fn().mockReturnValue(undefined)),
      },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { jwt: { secret: 'test-secret', expiresIn: 3600 }, sign: { up: true }, cookie: { secure: false, sameSite: 'lax' } },
    }));

    jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
      default: {},
    }));

    jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
      default: {},
    }));

    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { capture: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn((err) => err?.message || 'error') },
    }));

    jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
      default: class AppError extends Error {},
    }));

    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: jest.fn(),
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { processUser: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn(() => []),
    }));

    jest.unstable_mockModule('../../users/models/users.schema.js', () => ({
      default: {},
    }));

    jest.unstable_mockModule('passport', () => ({
      default: { authenticate: jest.fn(() => jest.fn()) },
    }));

    jest.unstable_mockModule('jsonwebtoken', () => ({
      default: { sign: jest.fn(() => 'fake_token') },
    }));

    // Mock eligibility registry (imported by auth.controller.js)
    jest.unstable_mockModule('../services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
    }));

    const mod = await import('../controllers/auth.controller.js');
    verifyEmail = mod.default.verifyEmail;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('handleSignupOrganization called on successful email verification', async () => {
    const req = makeReq();
    const res = makeRes();

    await verifyEmail(req, res);

    expect(mockOrganizationsService.handleSignupOrganization).toHaveBeenCalledTimes(1);
  });

  test('handleSignupOrganization called with the verified user', async () => {
    const req = makeReq();
    const res = makeRes();

    await verifyEmail(req, res);

    const [calledUser] = mockOrganizationsService.handleSignupOrganization.mock.calls[0];
    expect(calledUser.emailVerified).toBe(true);
  });

  test('org provisioning failure is non-fatal — verifyEmail still sends the success envelope', async () => {
    mockOrganizationsService.handleSignupOrganization.mockRejectedValue(new Error('DB unavailable'));
    const req = makeReq();
    const res = makeRes();

    await verifyEmail(req, res);

    const { default: responses } = await import('../../../lib/helpers/responses.js');
    expect(responses.error).not.toHaveBeenCalled();
    expect(responses.success).toHaveBeenCalledWith(res, 'Email verified successfully');
    const successBody = responses.success.mock.results[0].value;
    expect(successBody).toHaveBeenCalledWith({ emailVerified: true });
  });

  test('invalid/expired token — handleSignupOrganization NOT called', async () => {
    mockUserService.getBrut.mockResolvedValue(null);
    const req = makeReq('bad_token');
    const res = makeRes();

    await verifyEmail(req, res);

    expect(mockOrganizationsService.handleSignupOrganization).not.toHaveBeenCalled();
  });
});
