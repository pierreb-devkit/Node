/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.grantClaim.repository.js (#4155).
 */
describe('BillingGrantClaimRepository unit tests:', () => {
  let BillingGrantClaimRepository;
  let mockModel;

  const orgId = '507f1f77bcf86cd799439011';
  const otherOrgId = '507f1f77bcf86cd799439022';

  const makeE11000 = () => {
    const err = new Error('E11000 duplicate key error');
    err.code = 11000;
    return err;
  };

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      create: jest.fn(),
      findOne: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/billing.grantClaim.repository.js');
    BillingGrantClaimRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('tryClaim', () => {
    test('fresh key → { claimed: true }, no lookup needed', async () => {
      mockModel.create.mockResolvedValue({ key: 'k1', organization: orgId });

      const result = await BillingGrantClaimRepository.tryClaim('k1', orgId);

      expect(result).toEqual({ claimed: true });
      expect(mockModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'k1', organization: orgId }),
      );
      expect(mockModel.findOne).not.toHaveBeenCalled();
    });

    test('duplicate key already owned by the SAME org → { claimed: false, ownerOrgId: orgId }', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ key: 'k1', organization: orgId }) });

      const result = await BillingGrantClaimRepository.tryClaim('k1', orgId);

      expect(result).toEqual({ claimed: false, ownerOrgId: orgId });
      expect(mockModel.findOne).toHaveBeenCalledWith({ key: 'k1' });
    });

    test('duplicate key already owned by a DIFFERENT org → { claimed: false, ownerOrgId: otherOrgId }', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ key: 'k1', organization: otherOrgId }) });

      const result = await BillingGrantClaimRepository.tryClaim('k1', orgId);

      expect(result).toEqual({ claimed: false, ownerOrgId: otherOrgId });
    });

    test('duplicate key but lookup finds nothing (race window: claim deleted between insert-fail and lookup) → ownerOrgId: null', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      const result = await BillingGrantClaimRepository.tryClaim('k1', orgId);

      expect(result).toEqual({ claimed: false, ownerOrgId: null });
    });

    test('a non-duplicate-key error propagates (never swallowed as a claim conflict)', async () => {
      mockModel.create.mockRejectedValueOnce(new Error('connection reset'));

      await expect(BillingGrantClaimRepository.tryClaim('k1', orgId)).rejects.toThrow('connection reset');
      expect(mockModel.findOne).not.toHaveBeenCalled();
    });
  });
});
