import { jest } from '@jest/globals';

const mockService = {
  create: jest.fn(),
  list: jest.fn(),
  revoke: jest.fn(),
  resend: jest.fn(),
  findValid: jest.fn(),
  get: jest.fn(),
};

const successInner = jest.fn();
const errorInner = jest.fn();
const success = jest.fn(() => successInner);
const error = jest.fn(() => errorInner);
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.unstable_mockModule('../services/invitations.service.js', () => ({ default: mockService }));
jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({ default: { success, error } }));
jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({ default: { getMessage: jest.fn((e) => e?.message || 'err') } }));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));

const controller = (await import('../controllers/invitations.controller.js')).default;

/**
 * Creates a mock Express response object for testing.
 * @returns {Object} Empty object representing a mock response
 */
const makeRes = () => ({});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('invitations.controller.create', () => {
  test('creates an invitation and responds success', async () => {
    mockService.create.mockResolvedValue({ id: 'i1', email: 'a@b.co' });
    const req = { body: { email: 'a@b.co' }, user: { id: 'admin' } };
    await controller.create(req, makeRes());
    expect(mockService.create).toHaveBeenCalledWith('a@b.co', { id: 'admin' });
    expect(success).toHaveBeenCalled();
    expect(successInner).toHaveBeenCalledWith({ id: 'i1', email: 'a@b.co' });
  });
  test('maps a thrown error to 422', async () => {
    mockService.create.mockRejectedValue(new Error('boom'));
    await controller.create({ body: { email: 'a@b.co' }, user: {} }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), 422, 'Unprocessable Entity', 'boom');
  });
  test('threads a service 409 (duplicate pending) through as Conflict', async () => {
    mockService.create.mockRejectedValue(Object.assign(new Error('A pending invitation already exists for this email'), { status: 409 }));
    await controller.create({ body: { email: 'a@b.co' }, user: {} }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), 409, 'Conflict', 'A pending invitation already exists for this email');
  });
});

describe('invitations.controller.list', () => {
  test('passes the authenticated caller to the service (role-keyed scoping, #3833)', async () => {
    mockService.list.mockResolvedValue([{ id: 'i1' }]);
    const req = { user: { id: 'u1', roles: ['user'] } };
    await controller.list(req, makeRes());
    expect(mockService.list).toHaveBeenCalledWith({ id: 'u1', roles: ['user'] });
    expect(successInner).toHaveBeenCalledWith([{ id: 'i1' }]);
  });
});

describe('invitations.controller.remove', () => {
  test('revokes the loaded invitation and echoes its id', async () => {
    mockService.revoke.mockResolvedValue({ deletedCount: 1 });
    await controller.remove({ invitation: { id: 'i9' } }, makeRes());
    expect(mockService.revoke).toHaveBeenCalledWith('i9');
    expect(successInner).toHaveBeenCalledWith({ id: 'i9' });
  });
  test('responds 409 Conflict when revoke matches no pending row (accepted / already revoked)', async () => {
    mockService.revoke.mockResolvedValue(null);
    await controller.remove({ invitation: { id: 'i9' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), 409, 'Conflict', 'Only pending invitations can be revoked');
    expect(success).not.toHaveBeenCalled();
  });
});

describe('invitations.controller.resend', () => {
  test('resends via the service and responds success', async () => {
    mockService.resend.mockResolvedValue({ id: 'i1', status: 'pending' });
    await controller.resend({ invitation: { id: 'i1' } }, makeRes());
    expect(mockService.resend).toHaveBeenCalledWith('i1');
    expect(success).toHaveBeenCalledWith(expect.anything(), 'invitation resent');
    expect(successInner).toHaveBeenCalledWith({ id: 'i1', status: 'pending' });
  });
  test('threads a 409 (non-pending) as Conflict', async () => {
    mockService.resend.mockRejectedValue(Object.assign(new Error('Only pending invitations can be resent'), { status: 409 }));
    await controller.resend({ invitation: { id: 'i1' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), 409, 'Conflict', expect.any(String));
  });
  test('maps a 422 (mailer unconfigured) as Unprocessable Entity', async () => {
    mockService.resend.mockRejectedValue(Object.assign(new Error('mailer is not configured'), { status: 422 }));
    await controller.resend({ invitation: { id: 'i1' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), 422, 'Unprocessable Entity', expect.any(String));
  });
  // #3966 hardening: a bare transport rejection (no `.status`, unlike the
  // deliberate AppErrors above) must not leak the raw provider/SMTP error
  // string to the client — only a stable generic message — while the real
  // error still gets logged server-side with context.
  test('mail-transport failure (no .status) responds with a generic message, never the raw provider error, and logs server-side', async () => {
    const providerError = new Error('Resend API error: 401 Unauthorized — invalid API key sk_live_abc123');
    mockService.resend.mockRejectedValue(providerError);
    await controller.resend({ invitation: { id: 'i1' } }, makeRes());

    expect(error).toHaveBeenCalledWith(expect.anything(), 422, 'Unprocessable Entity', expect.any(String));
    const clientMessage = error.mock.calls[0][3];
    expect(clientMessage).not.toContain('sk_live_abc123');
    expect(clientMessage).not.toContain('Resend API error');
    expect(clientMessage).toBe('Failed to send the email, please try again.');

    expect(mockLogger.error).toHaveBeenCalledWith('[invitations.resend] failed', expect.objectContaining({
      invitationId: 'i1',
      message: providerError.message,
    }));
  });
});

describe('invitations.controller.verify', () => {
  test('reports valid + email for a fresh token', async () => {
    mockService.findValid.mockResolvedValue({ email: 'a@b.co' });
    await controller.verify({ params: { token: 'tok' } }, makeRes());
    expect(mockService.findValid).toHaveBeenCalledWith('tok');
    expect(successInner).toHaveBeenCalledWith({ valid: true, email: 'a@b.co' });
  });
  test('reports invalid for an unknown token', async () => {
    mockService.findValid.mockResolvedValue(null);
    await controller.verify({ params: { token: 'nope' } }, makeRes());
    expect(successInner).toHaveBeenCalledWith({ valid: false, email: null });
  });
});

describe('invitations.controller.invitationByID', () => {
  test('loads the invitation onto req and calls next', async () => {
    mockService.get.mockResolvedValue({ id: 'i1' });
    const req = {};
    const next = jest.fn();
    await controller.invitationByID(req, makeRes(), next, 'i1');
    expect(req.invitation).toEqual({ id: 'i1' });
    expect(next).toHaveBeenCalledWith();
  });
  test('404s when the id resolves to nothing', async () => {
    mockService.get.mockResolvedValue(null);
    const next = jest.fn();
    await controller.invitationByID({}, makeRes(), next, 'missing');
    expect(error).toHaveBeenCalledWith(expect.anything(), 404, 'Not Found', expect.any(String));
    expect(next).not.toHaveBeenCalled();
  });
  test('forwards a thrown error to next', async () => {
    const boom = new Error('db down');
    mockService.get.mockRejectedValue(boom);
    const next = jest.fn();
    await controller.invitationByID({}, makeRes(), next, 'i1');
    expect(next).toHaveBeenCalledWith(boom);
  });
});
