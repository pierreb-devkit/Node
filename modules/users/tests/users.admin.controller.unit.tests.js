/**
 * Unit tests — users.admin.controller get() security
 * Verifies that GET /users/:id does NOT leak sensitive fields (password, salt,
 * resetPasswordToken, resetPasswordExpires).
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ── mock UserService ──────────────────────────────────────────────────────────
const mockRemoveSensitive = jest.fn();

jest.unstable_mockModule('../services/users.service.js', () => ({
  default: {
    list: jest.fn(),
    get: jest.fn(),
    getBrut: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    removeSensitive: mockRemoveSensitive,
  },
}));

// ── mock MembershipService ────────────────────────────────────────────────────
const mockListByUser = jest.fn();
const mockListByUsers = jest.fn();

jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
  default: {
    listByUser: mockListByUser,
    listByUsers: mockListByUsers,
  },
}));

// ── mock helpers (errors + responses) ────────────────────────────────────────
jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
  default: { getMessage: jest.fn((err) => err.message || String(err)) },
}));

// responses.success(res, msg)(data) → res.json({ data })
// responses.error(res, code, label, msg)() → res.status(code).json({ message: msg })
jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
  default: {
    // eslint-disable-next-line no-unused-vars
    success: (_res, _label) => (data) => _res.json({ data }),
    error:
      (_res, code, _label, msg) =>
      () =>
        _res.status(code).json({ message: msg }),
  },
}));

// ── lazy import after mocks are registered ────────────────────────────────────
const { default: controller } = await import('../controllers/users.admin.controller.js');

// ── helpers ───────────────────────────────────────────────────────────────────
const SAFE_KEYS = ['_id', 'id', 'firstName', 'lastName', 'email', 'roles', 'provider'];

/** Simulates what UserService.removeSensitive does: pick only safe keys. */
const sanitize = (user) => {
  const plain = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
  return Object.fromEntries(SAFE_KEYS.filter((k) => k in plain).map((k) => [k, plain[k]]));
};

const buildMockUser = () => ({
  _id: 'uid-1',
  id: 'uid-1',
  firstName: 'Alice',
  lastName: 'Tester',
  email: 'alice@test.com',
  roles: ['user', 'admin'],
  provider: 'local',
  password: 'hashed-should-not-leak',
  salt: 'some-salt',
  resetPasswordToken: 'tok-abc',
  resetPasswordExpires: new Date('2099-01-01'),
  toJSON() {
    // Intentionally return ALL fields including secrets (simulates missing select:false)
    return { ...this };
  },
});

// ── tests ─────────────────────────────────────────────────────────────────────
describe('users.admin.controller unit tests:', () => {
  describe('get() — sensitive field sanitization', () => {
    let mockUser;
    let req;
    let res;

    beforeEach(() => {
      jest.clearAllMocks();
      mockUser = buildMockUser();
      req = { model: mockUser };
      res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      };
      mockListByUser.mockResolvedValue([]);
      // Wire removeSensitive to the real sanitize logic (picks only safe keys)
      mockRemoveSensitive.mockImplementation(sanitize);
    });

    test('should NOT include password in the response', async () => {
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser).not.toHaveProperty('password');
    });

    test('should NOT include salt in the response', async () => {
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser).not.toHaveProperty('salt');
    });

    test('should NOT include resetPasswordToken in the response', async () => {
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser).not.toHaveProperty('resetPasswordToken');
    });

    test('should NOT include resetPasswordExpires in the response', async () => {
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser).not.toHaveProperty('resetPasswordExpires');
    });

    test('should include safe fields (email, roles) in the response', async () => {
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser.email).toBe('alice@test.com');
      expect(responseUser.roles).toEqual(['user', 'admin']);
    });

    test('should return empty-ish object when req.model is absent', async () => {
      req = {};
      await controller.get(req, res);
      const responseUser = res.json.mock.calls[0][0].data;
      expect(responseUser).toEqual({ memberships: [] });
    });
  });
});
