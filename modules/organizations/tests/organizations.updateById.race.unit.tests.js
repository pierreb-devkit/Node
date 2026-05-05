/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for OrganizationsRepository.updateById and OrganizationsCrudService.update
 * (#3605 — race-condition fix: replace full-doc save with $set sparse patch)
 *
 * Race scenario validated:
 *   1. Fetch org doc (plan = 'free')
 *   2. Mid-flight: Stripe webhook calls setPlan(orgId, 'pro') → raw findByIdAndUpdate
 *   3. Service calls updateById with { name: 'New name' } patch
 *   4. Asserts: doc has BOTH plan='pro' AND name='New name' — no clobber
 */

// ─── Repository unit tests ───────────────────────────────────────────────────

describe('OrganizationsRepository.updateById (#3605):', () => {
  let OrganizationsRepository;
  let mockModel;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    const mockPopulate = jest.fn().mockReturnThis();
    const mockExec = jest.fn();

    mockModel = {
      findByIdAndUpdate: jest.fn().mockReturnValue({
        populate: mockPopulate,
        exec: mockExec,
      }),
    };
    // Store refs so individual tests can override exec
    mockModel._mockPopulate = mockPopulate;
    mockModel._mockExec = mockExec;

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/organizations.repository.js');
    OrganizationsRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('calls findByIdAndUpdate with $set and returns populated doc', async () => {
    const updatedOrg = { _id: orgId, name: 'New name', plan: 'pro' };
    mockModel._mockExec.mockResolvedValue(updatedOrg);

    const result = await OrganizationsRepository.updateById(orgId, { name: 'New name' });

    expect(mockModel.findByIdAndUpdate).toHaveBeenCalledWith(
      orgId,
      { $set: { name: 'New name' } },
      expect.objectContaining({ new: true, runValidators: true }),
    );
    expect(result).toEqual(updatedOrg);
  });

  test('returns null for invalid orgId without querying DB', async () => {
    const result = await OrganizationsRepository.updateById('not-valid', { name: 'X' });

    expect(result).toBeNull();
    expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('returns null for empty orgId without querying DB', async () => {
    const result = await OrganizationsRepository.updateById('', { name: 'X' });

    expect(result).toBeNull();
    expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('propagates DB errors to the caller', async () => {
    const dbErr = new Error('timeout');
    mockModel._mockExec.mockRejectedValue(dbErr);

    await expect(OrganizationsRepository.updateById(orgId, { name: 'X' })).rejects.toThrow('timeout');
  });
});

// ─── Service race-condition test ──────────────────────────────────────────────

describe('OrganizationsCrudService.update — race-condition invariant (#3605):', () => {
  const orgId = '507f1f77bcf86cd799439011';

  // Simulated in-memory "DB state" tracking concurrent writes
  let dbState;

  // Mock updateById: applies patch to dbState and returns merged doc
  const mockUpdateById = jest.fn().mockImplementation(async (_id, patch) => {
    // Simulate atomic $set: only patch fields are written, others survive
    dbState = { ...dbState, ...patch };
    return { ...dbState };
  });

  // Mock setPlan (Stripe webhook path): raw findByIdAndUpdate on plan only
  const mockFindByIdAndUpdate = jest.fn().mockImplementation(async (_id, planPatch) => {
    dbState = { ...dbState, ...planPatch };
    return { ...dbState };
  });

  beforeEach(async () => {
    jest.resetModules();

    dbState = { _id: orgId, name: 'Old name', plan: 'free', slug: 'old-org', domain: '', description: '' };

    jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
      default: {
        updateById: mockUpdateById,
        findOne: jest.fn().mockResolvedValue(null),
      },
    }));

    jest.unstable_mockModule('../../users/services/users.service.js', () => ({
      default: { updateById: jest.fn() },
    }));

    jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
      default: {
        list: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ _id: 'm1' }),
        deleteMany: jest.fn(),
        findOne: jest.fn().mockResolvedValue(null),
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
      default: class AppError extends Error {
        constructor(msg, opts) { super(msg); this.code = opts?.code; }
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/emailVerification.js', () => ({
      assertEmailVerified: jest.fn(),
    }));

    jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
      slugify: jest.fn().mockReturnValue('old-org'),
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { organizations: { publicDomains: [] } },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockUpdateById.mockClear();
    mockFindByIdAndUpdate.mockClear();
  });

  test(
    'concurrent setPlan write is preserved — $set patch never overwrites plan (#3605 race fix)',
    async () => {
      const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');

      // Org doc as fetched before the webhook fires (plan = 'free')
      const organization = { _id: orgId, id: orgId, name: 'Old name', plan: 'free', slug: 'old-org', domain: '' };

      // Mid-flight: Stripe webhook sets plan = 'pro' directly in the DB
      await mockFindByIdAndUpdate(orgId, { plan: 'pro' });
      // DB now: { name: 'Old name', plan: 'pro' }

      // Service update: only name patch, plan field absent from body (billing-owned)
      const result = await OrgCrudService.update(organization, { name: 'New name' });

      // updateById must have been called with a patch that does NOT contain 'plan'
      const [, patch] = mockUpdateById.mock.calls[0];
      expect(patch).not.toHaveProperty('plan');

      // The returned doc must have BOTH the webhook's plan AND the service's name change
      expect(result.name).toBe('New name');
      expect(result.plan).toBe('pro'); // webhook write survives — no clobber
    },
  );

  test(
    'billing-owned fields in body are stripped defensively — plan never flows through update (#3605)',
    async () => {
      const { default: OrgCrudService } = await import('../services/organizations.crud.service.js');

      const organization = { _id: orgId, id: orgId, name: 'Old name', plan: 'free', slug: 'old-org', domain: '' };

      // Attempt to pass plan via body (e.g. admin script or future refactor)
      await OrgCrudService.update(organization, { name: 'New name', plan: 'enterprise' });

      const [, patch] = mockUpdateById.mock.calls[0];
      expect(patch).not.toHaveProperty('plan');
      expect(patch).not.toHaveProperty('stripeCustomerId');
      expect(patch).not.toHaveProperty('stripeSubscriptionId');
    },
  );
});
