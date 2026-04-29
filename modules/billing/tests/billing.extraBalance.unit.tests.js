/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.extraBalance.repository.js and billing.extraBalance.schema.js
 */
describe('BillingExtraBalance unit tests:', () => {
  // ─── Schema tests ──────────────────────────────────────────────────────────

  describe('Schema validation', () => {
    let schema;

    beforeEach(async () => {
      const mod = await import('../models/billing.extraBalance.schema.js');
      schema = mod.default;
    });

    describe('BillingExtraBalance', () => {
      test('should be valid with minimal required fields', () => {
        const result = schema.BillingExtraBalance.safeParse({
          organization: '507f1f77bcf86cd799439011',
        });
        expect(result.error).toBeFalsy();
        expect(result.data.cachedBalance).toBe(0);
        expect(result.data.ledger).toEqual([]);
      });

      test('should reject invalid organizationId', () => {
        const result = schema.BillingExtraBalance.safeParse({
          organization: 'not-valid',
        });
        expect(result.error).toBeDefined();
      });

      test('should accept a valid ledger entry', () => {
        const result = schema.BillingExtraBalance.safeParse({
          organization: '507f1f77bcf86cd799439011',
          ledger: [
            {
              kind: 'topup',
              amount: 500000,
              stripeSessionId: 'cs_test_abc123',
            },
          ],
          cachedBalance: 500000,
        });
        expect(result.error).toBeFalsy();
        expect(result.data.ledger[0].kind).toBe('topup');
        expect(result.data.ledger[0].amount).toBe(500000);
      });

      test('should reject invalid ledger kind', () => {
        const result = schema.BillingExtraBalance.safeParse({
          organization: '507f1f77bcf86cd799439011',
          ledger: [{ kind: 'invalid', amount: 100 }],
        });
        expect(result.error).toBeDefined();
      });

      test('should accept all valid ledger kinds with correct sign', () => {
        // topup/adjustment require positive amount; debit/expiration/refund require negative
        const cases = [
          { kind: 'topup', amount: 100 },
          { kind: 'adjustment', amount: 100 },
          { kind: 'debit', amount: -100 },
          { kind: 'expiration', amount: -100 },
          { kind: 'refund', amount: -100 },
        ];
        for (const entry of cases) {
          const result = schema.LedgerEntry.safeParse(entry);
          expect(result.error).toBeFalsy();
        }
      });

      test('should accept negative amount for debit kind', () => {
        const result = schema.LedgerEntry.safeParse({ kind: 'debit', amount: -500 });
        expect(result.error).toBeFalsy();
        expect(result.data.amount).toBe(-500);
      });
    });

    describe('ExtraBalanceCreditPack', () => {
      test('should be valid with required fields', () => {
        const result = schema.ExtraBalanceCreditPack.safeParse({
          orgId: '507f1f77bcf86cd799439011',
          amount: 500000,
          stripeSessionId: 'cs_test_abc',
        });
        expect(result.error).toBeFalsy();
      });

      test('should reject amount of 0', () => {
        const result = schema.ExtraBalanceCreditPack.safeParse({
          orgId: '507f1f77bcf86cd799439011',
          amount: 0,
          stripeSessionId: 'cs_test_abc',
        });
        expect(result.error).toBeDefined();
      });

      test('should accept optional expiresAt', () => {
        const result = schema.ExtraBalanceCreditPack.safeParse({
          orgId: '507f1f77bcf86cd799439011',
          amount: 500000,
          stripeSessionId: 'cs_test_abc',
          expiresAt: '2027-01-01T00:00:00Z',
        });
        expect(result.error).toBeFalsy();
        expect(result.data.expiresAt).toBeInstanceOf(Date);
      });
    });

    describe('ExtraBalanceDebit', () => {
      test('should be valid with required fields', () => {
        const result = schema.ExtraBalanceDebit.safeParse({
          orgId: '507f1f77bcf86cd799439011',
          amount: 1000,
          refId: 'history_abc123',
        });
        expect(result.error).toBeFalsy();
      });

      test('should reject empty refId', () => {
        const result = schema.ExtraBalanceDebit.safeParse({
          orgId: '507f1f77bcf86cd799439011',
          amount: 1000,
          refId: '',
        });
        expect(result.error).toBeDefined();
      });
    });
  });

  // ─── Repository tests ──────────────────────────────────────────────────────

  describe('Repository', () => {
    let BillingExtraBalanceRepository;
    let mockModel;

    const orgId = '507f1f77bcf86cd799439011';
    /**
     * @param {Object} [overrides={}] - Fields to override on the stub document.
     * @returns {Object} A stub ExtraBalance document.
     */
    const makeDoc = (overrides = {}) => ({
      _id: '507f1f77bcf86cd799439099',
      organization: orgId,
      ledger: [],
      cachedBalance: 0,
      cachedBalanceAt: new Date(),
      ...overrides,
    });

    beforeEach(async () => {
      jest.resetModules();

      mockModel = {
        findOne: jest.fn(),
        findOneAndUpdate: jest.fn(),
        updateOne: jest.fn(),
        updateMany: jest.fn(),
      };

      jest.unstable_mockModule('mongoose', () => ({
        default: {
          model: jest.fn(() => mockModel),
          Types: {
            ObjectId: {
              isValid: jest.fn(() => true),
            },
          },
        },
      }));

      const mod = await import('../repositories/billing.extraBalance.repository.js');
      BillingExtraBalanceRepository = mod.default;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('getOrCreate', () => {
      test('should call findOneAndUpdate with upsert', async () => {
        const doc = makeDoc();
        mockModel.findOneAndUpdate.mockResolvedValue(doc);

        const result = await BillingExtraBalanceRepository.getOrCreate(orgId);

        expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
          { organization: orgId },
          expect.objectContaining({ $setOnInsert: expect.any(Object) }),
          expect.objectContaining({ upsert: true, returnDocument: 'after' }),
        );
        expect(result).toBe(doc);
      });

      test('should return null for malformed orgId (ObjectId guard)', async () => {
        const { default: mongoose } = await import('mongoose');
        mongoose.Types.ObjectId.isValid = jest.fn(() => false);

        const result = await BillingExtraBalanceRepository.getOrCreate('not-valid-id');
        expect(result).toBeNull();
        expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });

    describe('creditPack — idempotency', () => {
      test('should apply credit when stripeSessionId is new', async () => {
        const updatedDoc = makeDoc({ cachedBalance: 500000, ledger: [{ kind: 'topup', amount: 500000, stripeSessionId: 'cs_abc' }] });
        mockModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

        const result = await BillingExtraBalanceRepository.creditPack(orgId, 500000, 'cs_abc', null);

        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(500000);
      });

      test('should return applied=false when stripeSessionId already exists (idempotency)', async () => {
        // First findOneAndUpdate returns null (filter excluded — session already present)
        mockModel.findOneAndUpdate.mockResolvedValue(null);
        // creditPack fallback uses findOne().lean() to fetch existing doc
        const existingDoc = makeDoc({ cachedBalance: 500000, ledger: [{ kind: 'topup', amount: 500000, stripeSessionId: 'cs_abc' }] });
        mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(existingDoc) });

        const result = await BillingExtraBalanceRepository.creditPack(orgId, 500000, 'cs_abc', null);

        expect(result.applied).toBe(false);
        expect(result.doc).toBe(existingDoc);
      });

      test('should set expiresAt on topup entry when provided', async () => {
        const expiresAt = new Date('2027-01-01');
        let capturedUpdate;
        mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
          capturedUpdate = update;
          return Promise.resolve(makeDoc({ cachedBalance: 1000, ledger: [{ kind: 'topup', amount: 1000, stripeSessionId: 'cs_xyz', expiresAt }] }));
        });

        await BillingExtraBalanceRepository.creditPack(orgId, 1000, 'cs_xyz', expiresAt);

        expect(capturedUpdate.$push.ledger.expiresAt).toBe(expiresAt);
      });
    });

    describe('debit', () => {
      test('should apply debit when balance is sufficient and refId is new', async () => {
        const updatedDoc = makeDoc({ cachedBalance: 400000, ledger: [{ kind: 'debit', amount: -100000, refId: 'ref_1' }] });
        mockModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

        const result = await BillingExtraBalanceRepository.debit(orgId, 100000, 'ref_1');

        expect(result.applied).toBe(true);
        expect(result.doc).toBe(updatedDoc);
      });

      test('should return applied=false when balance is insufficient', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue(null);

        const result = await BillingExtraBalanceRepository.debit(orgId, 999999, 'ref_big');

        expect(result.applied).toBe(false);
        expect(result.doc).toBeNull();
      });

      test('should return applied=false when refId already used (replay protection)', async () => {
        // The filter `ledger.refId: { $ne: refId }` won't match if refId exists
        mockModel.findOneAndUpdate.mockResolvedValue(null);

        const result = await BillingExtraBalanceRepository.debit(orgId, 100, 'ref_duplicate');

        expect(result.applied).toBe(false);
      });

      test('should push a negative amount entry to the ledger', async () => {
        let capturedUpdate;
        mockModel.findOneAndUpdate.mockImplementation((filter, update) => {
          capturedUpdate = update;
          return Promise.resolve(makeDoc({ cachedBalance: 0 }));
        });

        await BillingExtraBalanceRepository.debit(orgId, 500, 'ref_check');

        expect(capturedUpdate.$push.ledger.amount).toBe(-500);
        expect(capturedUpdate.$push.ledger.kind).toBe('debit');
        expect(capturedUpdate.$inc.cachedBalance).toBe(-500);
      });
    });

    describe('addExpirationEntries — idempotency', () => {
      test('should return 0 when no document exists', async () => {
        mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

        const result = await BillingExtraBalanceRepository.addExpirationEntries(orgId, new Date());
        expect(result).toBe(0);
      });

      test('should return 0 when no topup entries have expired', async () => {
        const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
        const doc = makeDoc({
          ledger: [{ _id: '507f1f77bcf86cd799439abc', kind: 'topup', amount: 1000, expiresAt: future }],
        });
        mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) });

        const result = await BillingExtraBalanceRepository.addExpirationEntries(orgId, new Date());
        expect(result).toBe(0);
      });

      test('should expire a topup entry and return 1', async () => {
        const past = new Date(Date.now() - 1000);
        const entryId = '507f1f77bcf86cd799439abc';
        const doc = makeDoc({
          ledger: [{ _id: entryId, kind: 'topup', amount: 1000, expiresAt: past }],
        });
        mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) });
        mockModel.findOneAndUpdate.mockResolvedValue(makeDoc({ cachedBalance: 0 }));

        const result = await BillingExtraBalanceRepository.addExpirationEntries(orgId, new Date());
        expect(result).toBe(1);

        // Verify expiration entry references the topup id
        const call = mockModel.findOneAndUpdate.mock.calls[0];
        expect(call[1].$push.ledger.refId).toBe(`expire-${entryId}`);
        expect(call[1].$push.ledger.kind).toBe('expiration');
        expect(call[1].$push.ledger.amount).toBe(-1000);
      });

      test('should NOT add a second expiration entry when already expired (idempotent)', async () => {
        const past = new Date(Date.now() - 1000);
        const entryId = '507f1f77bcf86cd799439abc';
        const doc = makeDoc({
          ledger: [
            { _id: entryId, kind: 'topup', amount: 1000, expiresAt: past },
            { kind: 'expiration', amount: -1000, refId: `expire-${entryId}` },
          ],
        });
        mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) });

        const result = await BillingExtraBalanceRepository.addExpirationEntries(orgId, new Date());
        expect(result).toBe(0);
        expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });

    describe('getBalance', () => {
      test('should return cached balance', async () => {
        mockModel.findOne.mockReturnValue({
          lean: jest.fn().mockResolvedValue({ cachedBalance: 123456 }),
        });

        const balance = await BillingExtraBalanceRepository.getBalance(orgId);
        expect(balance).toBe(123456);
      });

      test('should return 0 when no document exists', async () => {
        mockModel.findOne.mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        });

        const balance = await BillingExtraBalanceRepository.getBalance(orgId);
        expect(balance).toBe(0);
      });
    });

    describe('refundPartial', () => {
      test('should apply refund atomically when refId is new', async () => {
        const updatedDoc = makeDoc({ cachedBalance: 0 });
        mockModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

        const result = await BillingExtraBalanceRepository.refundPartial(
          orgId,
          'cs_refund_test',
          500000,
          'refund-cs_refund_test-4900',
        );

        expect(result.applied).toBe(true);
        expect(result.doc).toBe(updatedDoc);

        const call = mockModel.findOneAndUpdate.mock.calls[0];
        expect(call[0]).toEqual({ organization: orgId, 'ledger.refId': { $ne: 'refund-cs_refund_test-4900' } });
        expect(call[1].$push.ledger.kind).toBe('refund');
        expect(call[1].$push.ledger.amount).toBe(-500000);
        expect(call[1].$push.ledger.stripeSessionId).toBe('cs_refund_test');
        expect(call[1].$push.ledger.refId).toBe('refund-cs_refund_test-4900');
        expect(call[1].$inc.cachedBalance).toBe(-500000);
      });

      test('should return applied=false when refId already used (idempotent)', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue(null);

        const result = await BillingExtraBalanceRepository.refundPartial(
          orgId,
          'cs_refund_test',
          500000,
          'refund-cs_refund_test-4900',
        );

        expect(result.applied).toBe(false);
        expect(result.doc).toBeNull();
      });

      test('should allow negative resulting balance (economic reflection)', async () => {
        const updatedDoc = makeDoc({ cachedBalance: -500000 });
        mockModel.findOneAndUpdate.mockResolvedValue(updatedDoc);

        const result = await BillingExtraBalanceRepository.refundPartial(orgId, 'cs_neg', 500000, 'refund-cs_neg-4900');
        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(-500000);
      });

      test('should throw on zero refundUnits', async () => {
        await expect(
          BillingExtraBalanceRepository.refundPartial(orgId, 'cs_abc', 0, 'refund-key'),
        ).rejects.toThrow('invalid argument: refundUnits must be a positive finite number');
      });

      test('should throw on empty refId', async () => {
        await expect(
          BillingExtraBalanceRepository.refundPartial(orgId, 'cs_abc', 100, ''),
        ).rejects.toThrow('invalid argument: refId must be a non-empty string');
      });
    });

    describe('creditPack — input guards', () => {
      test('should throw on zero amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditPack(orgId, 0, 'cs_test', null),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on negative amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditPack(orgId, -100, 'cs_test', null),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on empty stripeSessionId', async () => {
        await expect(
          BillingExtraBalanceRepository.creditPack(orgId, 100, '', null),
        ).rejects.toThrow('invalid argument: stripeSessionId must be a non-empty string');
      });
    });

    describe('debit — input guards', () => {
      test('should throw on zero amount', async () => {
        await expect(
          BillingExtraBalanceRepository.debit(orgId, 0, 'ref_test'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on negative amount', async () => {
        await expect(
          BillingExtraBalanceRepository.debit(orgId, -50, 'ref_test'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on empty refId', async () => {
        await expect(
          BillingExtraBalanceRepository.debit(orgId, 100, ''),
        ).rejects.toThrow('invalid argument: refId must be a non-empty string');
      });
    });
  });
});
