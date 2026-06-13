import { jest } from '@jest/globals';

const mockService = {
  create: jest.fn(),
  list: jest.fn(),
  revoke: jest.fn(),
  findValid: jest.fn(),
  get: jest.fn(),
};

const successInner = jest.fn();
const errorInner = jest.fn();
const success = jest.fn(() => successInner);
const error = jest.fn(() => errorInner);

jest.unstable_mockModule('../services/invitations.service.js', () => ({ default: mockService }));
jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({ default: { success, error } }));
jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({ default: { getMessage: jest.fn((e) => e?.message || 'err') } }));

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
