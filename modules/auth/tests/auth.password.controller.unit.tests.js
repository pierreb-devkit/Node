/**
 * Module dependencies.
 *
 * Unit tests for auth.password.controller `forgot` handler.
 * Security regression guard:
 *   - Must return a UNIFORM response for both known and unknown emails (anti-enumeration, #3722).
 *   - Must run a dummy bcrypt hash on the unknown-user path to equalise timing (anti-timing-oracle, #3722).
 *   - Mail-send failure must NOT re-introduce an enumeration oracle (#3722 follow-up).
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const UNIFORM_MSG = 'If that email exists, a reset link has been sent.';

describe('auth.password.controller.forgot — account enumeration + timing oracle (#3722):', () => {
  let mockGetBrut;
  let mockUpdate;
  let mockSendMail;
  let mockBcryptCompare;
  let mockErrorFn;
  let mockSuccessFn;

  beforeEach(() => {
    jest.resetModules();

    mockGetBrut = jest.fn();
    mockUpdate = jest.fn();
    mockSendMail = jest.fn();
    mockBcryptCompare = jest.fn().mockResolvedValue(false);
    mockErrorFn = jest.fn().mockReturnValue(jest.fn());
    mockSuccessFn = jest.fn().mockReturnValue(jest.fn());

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));

    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { getBrut: mockGetBrut, update: mockUpdate },
    }));

    jest.unstable_mockModule('../../../modules/auth/services/auth.service.js', () => ({
      default: {
        comparePassword: mockBcryptCompare,
        hashPassword: jest.fn().mockResolvedValue('$2b$hashed'),
        checkPassword: jest.fn((p) => p),
        generateRandomPassphrase: jest.fn().mockReturnValue('random-passphrase'),
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: {
        isConfigured: jest.fn().mockReturnValue(true),
        sendMail: mockSendMail,
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
      default: jest.fn().mockReturnValue('http://localhost:3000'),
    }));

    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn().mockReturnValue('error') },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: mockSuccessFn,
        error: mockErrorFn,
      },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        jwt: { secret: 'test-secret', expiresIn: 3600 },
        cookie: { secure: false, sameSite: 'lax' },
        app: { title: 'Test App', contact: 'contact@test.com' },
      },
    }));
  });

  test('should return a UNIFORM 200 success response for an unknown email (no enumeration)', async () => {
    // Unknown user — getBrut returns null
    mockGetBrut.mockResolvedValueOnce(null);

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = { body: { email: 'unknown@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Must NOT call responses.error with user-not-found detail
    const errorCalls = responses.error.mock.calls;
    const enumLeakCall = errorCalls.find(
      (call) => typeof call[3] === 'string' && (call[3].toLowerCase().includes('account') || call[3].toLowerCase().includes('email') || call[3].toLowerCase().includes('found')),
    );
    expect(enumLeakCall).toBeUndefined();

    // Must call responses.success with the EXACT uniform message
    expect(responses.success).toHaveBeenCalledWith(res, UNIFORM_MSG);
  });

  test('should perform a dummy hash on the unknown-user path to equalise timing', async () => {
    // Unknown user — getBrut returns null
    mockGetBrut.mockResolvedValueOnce(null);

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: AuthService } = await import('../../../modules/auth/services/auth.service.js');

    const req = { body: { email: 'ghost@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Dummy hash must have been called (comparePassword or hashPassword)
    const dummyCalled = AuthService.comparePassword.mock.calls.length > 0 || AuthService.hashPassword.mock.calls.length > 0;
    expect(dummyCalled).toBe(true);
  });

  test('should return a UNIFORM success response for a known local user (same as unknown path)', async () => {
    const knownUser = {
      id: 'u1',
      email: 'known@example.com',
      provider: 'local',
      firstName: 'Jane',
      lastName: 'Doe',
      resetPasswordToken: 'tok123',
    };
    mockGetBrut.mockResolvedValueOnce(knownUser);
    mockUpdate.mockResolvedValueOnce({ ...knownUser, resetPasswordToken: 'tok123', resetPasswordExpires: Date.now() + 3600000 });
    mockSendMail.mockResolvedValueOnce({ accepted: ['known@example.com'] });

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = { body: { email: 'known@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Must call responses.success with the EXACT uniform message — regression guard against distinct responses
    expect(responses.success).toHaveBeenCalledWith(res, UNIFORM_MSG);
    // Must NOT call responses.error (no 400/422 for known local user)
    expect(responses.error).not.toHaveBeenCalled();
  });

  test('should NOT reveal OAuth provider in error response (no provider enumeration)', async () => {
    const oauthUser = {
      id: 'u2',
      email: 'oauth@example.com',
      provider: 'google',
      firstName: 'John',
      lastName: 'Smith',
    };
    mockGetBrut.mockResolvedValueOnce(oauthUser);

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = { body: { email: 'oauth@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Must NOT leak the provider name (google, facebook, etc.)
    const errorCalls = responses.error.mock.calls;
    const providerLeakCall = errorCalls.find(
      (call) => typeof call[3] === 'string' && call[3].toLowerCase().includes('google'),
    );
    expect(providerLeakCall).toBeUndefined();

    // Must call responses.success with the EXACT uniform message
    expect(responses.success).toHaveBeenCalledWith(res, UNIFORM_MSG);
  });

  test('should return the UNIFORM success response even when sendMail throws (no enumeration oracle on mail failure)', async () => {
    const knownUser = {
      id: 'u3',
      email: 'mailfail@example.com',
      provider: 'local',
      firstName: 'Mail',
      lastName: 'Fail',
      resetPasswordToken: 'tok456',
    };
    mockGetBrut.mockResolvedValueOnce(knownUser);
    mockUpdate.mockResolvedValueOnce({ ...knownUser, resetPasswordToken: 'tok456', resetPasswordExpires: Date.now() + 3600000 });
    // Simulate sendMail throwing (SMTP down, network error, etc.)
    mockSendMail.mockRejectedValueOnce(new Error('ECONNREFUSED: cannot connect to SMTP server'));

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = { body: { email: 'mailfail@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Must NOT call responses.error — mail failure must not be distinguishable from success
    expect(responses.error).not.toHaveBeenCalled();
    // Must still return the exact uniform success message
    expect(responses.success).toHaveBeenCalledWith(res, UNIFORM_MSG);
  });

  test('should return the UNIFORM success response when sendMail returns a rejected result (not accepted)', async () => {
    const knownUser = {
      id: 'u4',
      email: 'notaccepted@example.com',
      provider: 'local',
      firstName: 'Not',
      lastName: 'Accepted',
      resetPasswordToken: 'tok789',
    };
    mockGetBrut.mockResolvedValueOnce(knownUser);
    mockUpdate.mockResolvedValueOnce({ ...knownUser, resetPasswordToken: 'tok789', resetPasswordExpires: Date.now() + 3600000 });
    // Simulate sendMail returning a result without .accepted
    mockSendMail.mockResolvedValueOnce({ rejected: ['notaccepted@example.com'] });

    const { default: PasswordController } = await import('../controllers/auth.password.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    const req = { body: { email: 'notaccepted@example.com' } };
    const res = {};

    await PasswordController.forgot(req, res);

    // Must NOT call responses.error — mail rejection must not be distinguishable from success
    expect(responses.error).not.toHaveBeenCalled();
    // Must still return the exact uniform success message
    expect(responses.success).toHaveBeenCalledWith(res, UNIFORM_MSG);
  });
});
