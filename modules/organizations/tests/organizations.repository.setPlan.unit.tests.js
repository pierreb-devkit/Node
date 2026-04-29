/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for OrganizationRepository.setPlan (PR-N5)
 */
describe('OrganizationRepository.setPlan:', () => {
  let OrganizationRepository;
  let mockModel;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      findByIdAndUpdate: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/organizations.repository.js');
    OrganizationRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('calls findByIdAndUpdate with correct plan payload', async () => {
    const updatedOrg = { _id: orgId, plan: 'free' };
    mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedOrg) });

    const result = await OrganizationRepository.setPlan(orgId, 'free');

    expect(mockModel.findByIdAndUpdate).toHaveBeenCalledWith(
      orgId,
      { plan: 'free' },
      expect.objectContaining({ returnDocument: 'after', runValidators: true }),
    );
    expect(result).toEqual(updatedOrg);
  });

  test('returns null for invalid orgId without calling findByIdAndUpdate', async () => {
    const result = await OrganizationRepository.setPlan('not-valid', 'free');

    expect(result).toBeNull();
    expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('returns null for empty string orgId', async () => {
    const result = await OrganizationRepository.setPlan('', 'free');

    expect(result).toBeNull();
    expect(mockModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('propagates DB errors to the caller', async () => {
    const dbErr = new Error('connection lost');
    mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockRejectedValue(dbErr) });

    await expect(OrganizationRepository.setPlan(orgId, 'free')).rejects.toThrow('connection lost');
  });
});
