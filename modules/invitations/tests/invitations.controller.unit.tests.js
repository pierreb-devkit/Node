import { jest } from '@jest/globals';

const mockService = {
  create: jest.fn(),
  list: jest.fn(),
  revoke: jest.fn(),
  resend: jest.fn(),
  verify: jest.fn(),
  get: jest.fn(),
  listForOrganization: jest.fn(),
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
  test('passes a thrown error through so responses.error resolves its status (500 when it has none)', async () => {
    const caughtError = new Error('boom');
    mockService.create.mockRejectedValue(caughtError);
    await controller.create({ body: { email: 'a@b.co' }, user: {} }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 'boom');
    expect(errorInner).toHaveBeenCalledWith(caughtError);
  });
  test('passes a service 409 (duplicate pending) through to responses.error', async () => {
    const caughtError = Object.assign(new Error('A pending invitation already exists for this email'), { status: 409 });
    mockService.create.mockRejectedValue(caughtError);
    await controller.create({ body: { email: 'a@b.co' }, user: {} }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 'A pending invitation already exists for this email');
    expect(errorInner).toHaveBeenCalledWith(caughtError);
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
  test('passes a thrown error through with no hard-coded status, so responses.error answers its own (403)', async () => {
    const caughtError = Object.assign(new Error('Forbidden'), { status: 403 });
    mockService.list.mockRejectedValue(caughtError);
    await controller.list({ user: { id: 'u1' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 'Forbidden');
    expect(errorInner).toHaveBeenCalledWith(caughtError);
    expect(success).not.toHaveBeenCalled();
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
  test('passes a thrown error through with no hard-coded status (500 when it has none)', async () => {
    const caughtError = new Error('db down');
    mockService.revoke.mockRejectedValue(caughtError);
    await controller.remove({ invitation: { id: 'i9' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 'db down');
    expect(errorInner).toHaveBeenCalledWith(caughtError);
  });
});

describe('invitations.controller.resend', () => {
  const admin = { roles: ['admin'] };

  test('resends via the service and responds success', async () => {
    mockService.resend.mockResolvedValue({ id: 'i1', status: 'pending' });
    await controller.resend({ invitation: { id: 'i1' }, user: admin }, makeRes());
    expect(mockService.resend).toHaveBeenCalledWith('i1', admin);
    expect(success).toHaveBeenCalledWith(expect.anything(), 'invitation resent');
    expect(successInner).toHaveBeenCalledWith({ id: 'i1', status: 'pending' });
  });
  test('passes a 409 (non-pending) through to responses.error', async () => {
    mockService.resend.mockRejectedValue(Object.assign(new Error('Only pending invitations can be resent'), { status: 409 }));
    await controller.resend({ invitation: { id: 'i1' }, user: admin }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, expect.any(String));
  });
  test('passes a 422 (mailer unconfigured) through to responses.error', async () => {
    mockService.resend.mockRejectedValue(Object.assign(new Error('mailer is not configured'), { status: 422 }));
    await controller.resend({ invitation: { id: 'i1' }, user: admin }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, expect.any(String));
  });
  // #3966 hardening: a bare transport rejection (no `.status`, unlike the
  // deliberate AppErrors above) must not leak the raw provider/SMTP error
  // string to the client — only a stable generic message — while the real
  // error still gets logged server-side with context.
  test('mail-transport failure (no .status) responds with a generic message, never the raw provider error, and logs server-side', async () => {
    const providerError = new Error('Resend API error: 401 Unauthorized — invalid API key sk_live_abc123');
    mockService.resend.mockRejectedValue(providerError);
    await controller.resend({ invitation: { id: 'i1' }, user: admin }, makeRes());

    expect(error).toHaveBeenCalledWith(expect.anything(), 500, undefined, expect.any(String));
    const clientMessage = error.mock.calls[0][3];
    expect(clientMessage).not.toContain('sk_live_abc123');
    expect(clientMessage).not.toContain('Resend API error');
    expect(clientMessage).toBe('Failed to send the email, please try again.');

    expect(mockLogger.error).toHaveBeenCalledWith('[invitations.resend] failed', expect.objectContaining({
      invitationId: 'i1',
      message: providerError.message,
    }));
  });

  // #3945: resend stays admin-only even though invitationAbilities can widen 'create'
  // to authenticated users — see invitations.policy.js / invitations.controller.js
  // comments for why CASL alone cannot close this gap (POST→'create' method-mapping
  // collision with new-invitation creation).
  describe('#3945 admin-only gate (defense-in-depth, independent of CASL)', () => {
    test('403s a non-admin caller and never calls the service', async () => {
      await controller.resend({ invitation: { id: 'i1' }, user: { roles: ['user'] } }, makeRes());
      expect(error).toHaveBeenCalledWith(expect.anything(), 403, 'Forbidden', 'Only platform admins can resend invitations');
      expect(mockService.resend).not.toHaveBeenCalled();
    });
    test('403s a caller with no roles array and never calls the service', async () => {
      await controller.resend({ invitation: { id: 'i1' }, user: {} }, makeRes());
      expect(error).toHaveBeenCalledWith(expect.anything(), 403, 'Forbidden', expect.any(String));
      expect(mockService.resend).not.toHaveBeenCalled();
    });
    test('403s when req.user is missing entirely and never calls the service', async () => {
      await controller.resend({ invitation: { id: 'i1' } }, makeRes());
      expect(error).toHaveBeenCalledWith(expect.anything(), 403, 'Forbidden', expect.any(String));
      expect(mockService.resend).not.toHaveBeenCalled();
    });
  });
});

describe('invitations.controller.verify', () => {
  test('responds with the service verify result', async () => {
    mockService.verify.mockResolvedValue({ valid: true, email: 'a@b.co', organization: { name: 'Acme' } });
    await controller.verify({ params: { token: 'tok' } }, makeRes());
    expect(mockService.verify).toHaveBeenCalledWith('tok');
    expect(successInner).toHaveBeenCalledWith({ valid: true, email: 'a@b.co', organization: { name: 'Acme' } });
  });
  test('passes a thrown error through with no hard-coded status (500 when it has none)', async () => {
    const caughtError = new Error('db down');
    mockService.verify.mockRejectedValue(caughtError);
    await controller.verify({ params: { token: 'tok' } }, makeRes());
    expect(error).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 'db down');
    expect(errorInner).toHaveBeenCalledWith(caughtError);
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

describe('invitations.controller — organization routes', () => {
  const org = { _id: 'org1', name: 'Acme Org' };
  const owner = { id: 'u-owner', roles: ['user'] };
  const ownerMembership = { role: 'owner', organizationId: 'org1' };
  const adminMembership = { role: 'admin', organizationId: 'org1' };
  const memberMembership = { role: 'member', organizationId: 'org1' };

  describe('requireOrganizationManager', () => {
    test.each([
      ['owner', ownerMembership],
      ['admin', adminMembership],
    ])('lets an org %s through', (_label, membership) => {
      const next = jest.fn();
      controller.requireOrganizationManager({ organization: org, user: owner, membership }, makeRes(), next);
      expect(next).toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
    test('lets a platform admin through without a membership', () => {
      const next = jest.fn();
      controller.requireOrganizationManager({ organization: org, user: { roles: ['user', 'admin'] }, membership: null }, makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
    test.each([
      ['a plain member', memberMembership],
      ['a non-member', null],
    ])('403s %s', (_label, membership) => {
      const next = jest.fn();
      controller.requireOrganizationManager({ organization: org, user: owner, membership }, makeRes(), next);
      expect(next).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.anything(), 403, 'Forbidden', 'Insufficient organization role');
    });
    test('404s (fail closed) when no organization is loaded', () => {
      const next = jest.fn();
      controller.requireOrganizationManager({ user: { roles: ['admin'] } }, makeRes(), next);
      expect(next).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.anything(), 404, 'Not Found', expect.any(String));
    });
  });

  describe('invitationInOrganization', () => {
    test('passes an invitation of this organization', () => {
      const next = jest.fn();
      controller.invitationInOrganization({ organization: org, invitation: { organizationId: 'org1' } }, makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
    test.each([
      ['another organization', { organizationId: 'org2' }],
      ['a platform invite', { organizationId: null }],
    ])('404s an invitation of %s', (_label, invitation) => {
      const next = jest.fn();
      controller.invitationInOrganization({ organization: org, invitation }, makeRes(), next);
      expect(next).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.anything(), 404, 'Not Found', expect.any(String));
    });
  });

  describe('organizationCreate', () => {
    test('creates a member invite by default and never returns the token', async () => {
      mockService.create.mockResolvedValue({ toJSON: () => ({ id: 'i1', email: 'a@b.co', token: 'secret', role: 'member' }) });
      const req = { body: { email: 'a@b.co' }, user: owner, membership: adminMembership, organization: org };
      await controller.organizationCreate(req, makeRes());
      expect(mockService.create).toHaveBeenCalledWith('a@b.co', owner, { organization: org, role: 'member' });
      expect(successInner).toHaveBeenCalledWith({ id: 'i1', email: 'a@b.co', role: 'member' });
    });
    test('an org admin cannot invite an admin (role ceiling) — 403, no create', async () => {
      const req = { body: { email: 'a@b.co', role: 'admin' }, user: owner, membership: adminMembership, organization: org };
      await controller.organizationCreate(req, makeRes());
      expect(error).toHaveBeenCalledWith(expect.anything(), 403, 'Forbidden', 'Only owners can invite with an elevated role');
      expect(mockService.create).not.toHaveBeenCalled();
    });
    test('an owner can invite an admin', async () => {
      mockService.create.mockResolvedValue({ id: 'i1', role: 'admin' });
      const req = { body: { email: 'a@b.co', role: 'admin' }, user: owner, membership: ownerMembership, organization: org };
      await controller.organizationCreate(req, makeRes());
      expect(mockService.create).toHaveBeenCalledWith('a@b.co', owner, { organization: org, role: 'admin' });
    });
    test('passes a service error through', async () => {
      const caughtError = Object.assign(new Error('A pending invitation already exists for this email'), { status: 409 });
      mockService.create.mockRejectedValue(caughtError);
      const req = { body: { email: 'a@b.co' }, user: owner, membership: ownerMembership, organization: org };
      await controller.organizationCreate(req, makeRes());
      expect(errorInner).toHaveBeenCalledWith(caughtError);
    });
  });

  describe('organizationList', () => {
    test('lists the org pending invites', async () => {
      mockService.listForOrganization.mockResolvedValue([{ id: 'i1' }]);
      await controller.organizationList({ organization: org }, makeRes());
      expect(mockService.listForOrganization).toHaveBeenCalledWith('org1');
      expect(successInner).toHaveBeenCalledWith([{ id: 'i1' }]);
    });
    test('passes a service error through', async () => {
      const caughtError = new Error('db down');
      mockService.listForOrganization.mockRejectedValue(caughtError);
      await controller.organizationList({ organization: org }, makeRes());
      expect(errorInner).toHaveBeenCalledWith(caughtError);
    });
  });

  describe('organizationResend', () => {
    test('resends for any org manager (no platform-admin gate) and strips the token', async () => {
      mockService.resend.mockResolvedValue({ id: 'i1', token: 'secret', status: 'pending' });
      await controller.organizationResend({ invitation: { id: 'i1' }, user: owner, organization: org }, makeRes());
      expect(mockService.resend).toHaveBeenCalledWith('i1', owner);
      expect(successInner).toHaveBeenCalledWith({ id: 'i1', status: 'pending' });
    });
  });
});
