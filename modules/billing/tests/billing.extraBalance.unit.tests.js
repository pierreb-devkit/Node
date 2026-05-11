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
        exists: jest.fn(),
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
        // Step 1: getOrCreate (no-op on existing); Step 2: actual credit
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepository.creditPack(orgId, 500000, 'cs_abc', null);

        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(500000);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });

      test('should return applied=false with reason duplicate_session when stripeSessionId already exists', async () => {
        // Step 1: getOrCreate succeeds; Step 2: idempotency filter excludes → null
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(null);

        const result = await BillingExtraBalanceRepository.creditPack(orgId, 500000, 'cs_abc', null);

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('duplicate_session');
        expect(result.doc).toBeNull();
      });

      test('step 1 issues upsert getOrCreate with $setOnInsert (fresh org support)', async () => {
        let step1Filter;
        let step1Update;
        let step1Options;
        const updatedDoc = makeDoc({ cachedBalance: 500000 });
        mockModel.findOneAndUpdate.mockImplementation((filter, update, options) => {
          if (!step1Filter) {
            step1Filter = filter;
            step1Update = update;
            step1Options = options;
            return Promise.resolve(null); // fresh org — no doc yet
          }
          return Promise.resolve(updatedDoc);
        });

        await BillingExtraBalanceRepository.creditPack(orgId, 500000, 'cs_fresh', null);

        expect(step1Options?.upsert).toBe(true);
        expect(step1Update.$setOnInsert).toMatchObject({ organization: orgId, ledger: [], cachedBalance: 0 });
      });

      test('step 2 does NOT include upsert (doc guaranteed by step 1)', async () => {
        let step2Options;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockImplementation((filter, update, options) => {
            step2Options = options;
            return Promise.resolve(makeDoc({ cachedBalance: 1000 }));
          });

        await BillingExtraBalanceRepository.creditPack(orgId, 1000, 'cs_no_upsert', null);

        expect(step2Options?.upsert).toBeFalsy();
      });

      test('should set expiresAt on topup entry when provided', async () => {
        const expiresAt = new Date('2027-01-01');
        let capturedUpdate;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockImplementation((filter, update) => {
            capturedUpdate = update;
            return Promise.resolve(makeDoc({ cachedBalance: 1000, ledger: [{ kind: 'topup', amount: 1000, stripeSessionId: 'cs_xyz', expiresAt }] }));
          });

        await BillingExtraBalanceRepository.creditPack(orgId, 1000, 'cs_xyz', expiresAt);

        expect(capturedUpdate.$push.ledger.expiresAt).toBe(expiresAt);
      });
    });

    describe('debit', () => {
      // Most debit tests start with an existing doc, bypassing the org-existence guard.
      // Tests that need fresh-org behaviour override exists individually.
      beforeEach(() => {
        // Default: doc exists → org check is skipped (exists returns truthy ObjectId)
        mockModel.exists.mockResolvedValue({ _id: orgId });
      });

      test('should apply debit when balance is sufficient and refId is new', async () => {
        const existingDoc = makeDoc();
        const updatedDoc = makeDoc({ cachedBalance: 400000, ledger: [{ kind: 'debit', amount: -100000, refId: 'ref_1' }] });
        // Step 1: getOrCreate (no-op on existing); Step 2: actual debit
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(existingDoc)
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepository.debit(orgId, 100000, 'ref_1');

        expect(result.applied).toBe(true);
        expect(result.doc).toBe(updatedDoc);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });

      test('should apply debit and allow negative balance when amount exceeds cachedBalance (overage)', async () => {
        // cachedBalance=10, amount=15 → balance becomes -5; applied=true (no balance guard)
        const existingDoc = makeDoc({ cachedBalance: 10 });
        const updatedDoc = makeDoc({ cachedBalance: -5, ledger: [{ kind: 'debit', amount: -15, refId: 'ref_overage' }] });
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(existingDoc)
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepository.debit(orgId, 15, 'ref_overage');

        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(-5);
      });

      test('step 1 issues upsert getOrCreate with $setOnInsert (fresh org — org exists)', async () => {
        // Simulate fresh org: exists returns null (no existing doc)
        // → org check triggered → org found → upsert proceeds
        mockModel.exists.mockResolvedValue(null);

        let step1Filter;
        let step1Update;
        let step1Options;
        const updatedDoc = makeDoc({ cachedBalance: -50 });

        // Reload module after adding the org mock
        jest.resetModules();
        jest.unstable_mockModule('mongoose', () => ({
          default: {
            model: jest.fn(() => mockModel),
            Types: { ObjectId: { isValid: jest.fn(() => true) } },
          },
        }));
        jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
          default: class AppError extends Error {
            constructor(message, { status, code } = {}) {
              super(message);
              this.status = status ?? 500;
              this.code = code;
            }
          },
        }));
        jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
          default: { exists: jest.fn().mockResolvedValue({ _id: orgId }) },
        }));
        const freshMod = await import('../repositories/billing.extraBalance.repository.js');
        const FreshRepo = freshMod.default;

        mockModel.exists.mockResolvedValue(null);
        mockModel.findOneAndUpdate.mockImplementation((filter, update, options) => {
          if (!step1Filter) {
            step1Filter = filter;
            step1Update = update;
            step1Options = options;
            return Promise.resolve(null);
          }
          return Promise.resolve(updatedDoc);
        });

        await FreshRepo.debit(orgId, 50, 'ref_fresh');

        expect(step1Options?.upsert).toBe(true);
        expect(step1Update.$setOnInsert).toMatchObject({ organization: orgId, ledger: [], cachedBalance: 0 });
      });

      test('filter does NOT include cachedBalance guard (allows negative balance)', async () => {
        const existingDoc = makeDoc();
        let step2Filter;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(existingDoc)
          .mockImplementation((filter) => {
            step2Filter = filter;
            return Promise.resolve(makeDoc({ cachedBalance: -5 }));
          });

        await BillingExtraBalanceRepository.debit(orgId, 15, 'ref_no_balance_guard');

        expect(step2Filter).not.toHaveProperty('cachedBalance');
      });

      test('should return applied=false with reason duplicate_step when refId already used (replay protection)', async () => {
        // Step 1: getOrCreate succeeds; Step 2: idempotency filter excludes → null
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(null);

        const result = await BillingExtraBalanceRepository.debit(orgId, 100, 'ref_duplicate');

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('duplicate_step');
      });

      test('should push a negative amount entry to the ledger', async () => {
        const existingDoc = makeDoc();
        let step2Update;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(existingDoc)
          .mockImplementation((filter, update) => {
            step2Update = update;
            return Promise.resolve(makeDoc({ cachedBalance: 0 }));
          });

        await BillingExtraBalanceRepository.debit(orgId, 500, 'ref_check');

        expect(step2Update.$push.ledger.amount).toBe(-500);
        expect(step2Update.$push.ledger.kind).toBe('debit');
        expect(step2Update.$inc.cachedBalance).toBe(-500);
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

    // ─────────────────────────────────────────────────────────────────────────────
    // debit — org-existence guard (Item 4 — Batch 2)
    // ─────────────────────────────────────────────────────────────────────────────
    describe('debit — org-existence guard (Opus H4):', () => {
      let BillingExtraBalanceRepositoryWithOrg;
      let mockModelWithOrg;
      let mockOrgRepository;

      beforeEach(async () => {
        jest.resetModules();

        mockModelWithOrg = {
          findOne: jest.fn(),
          findOneAndUpdate: jest.fn(),
          updateOne: jest.fn(),
          // Used by: 1) BillingExtraBalance.exists (doc pre-check), 2) Subscription.exists fallback
          exists: jest.fn().mockResolvedValue(null),
        };

        mockOrgRepository = {
          exists: jest.fn(),
        };

        jest.unstable_mockModule('mongoose', () => ({
          default: {
            // Route model() calls: Subscription check returns mockModelWithOrg (with exists);
            // BillingExtraBalance + all others also return mockModelWithOrg (simplest mock).
            model: jest.fn(() => mockModelWithOrg),
            Types: {
              ObjectId: { isValid: jest.fn(() => true) },
            },
          },
        }));
        jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
          default: class AppError extends Error {
            constructor(message, { status, code } = {}) {
              super(message);
              this.status = status ?? 500;
              this.code = code;
              this.name = 'AppError';
            }
          },
        }));
        jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
          default: mockOrgRepository,
        }));

        const mod = await import('../repositories/billing.extraBalance.repository.js');
        BillingExtraBalanceRepositoryWithOrg = mod.default;
      });

      test('debit for valid org when no existing doc — upserts without throwing', async () => {
        // No existing doc → triggers org check → org exists → proceeds
        mockModelWithOrg.exists.mockResolvedValueOnce(null); // BillingExtraBalance.exists → no doc
        mockOrgRepository.exists.mockResolvedValue({ _id: orgId });
        const updatedDoc = {
          _id: '507f1f77bcf86cd799439099',
          organization: orgId,
          ledger: [{ kind: 'debit', amount: -100, refId: 'ref_new_org' }],
          cachedBalance: -100,
          cachedBalanceAt: new Date(),
        };
        mockModelWithOrg.findOneAndUpdate
          .mockResolvedValueOnce(null) // upsert
          .mockResolvedValueOnce(updatedDoc); // debit

        const result = await BillingExtraBalanceRepositoryWithOrg.debit(orgId, 100, 'ref_new_org');

        expect(result.applied).toBe(true);
        expect(mockOrgRepository.exists).toHaveBeenCalledWith({ _id: orgId });
      });

      test('debit for valid org with existing doc — skips org check', async () => {
        // Existing doc → no org check needed (exists returns truthy)
        mockModelWithOrg.exists.mockResolvedValueOnce({ _id: orgId }); // BillingExtraBalance.exists → doc exists
        const existingDoc = {
          _id: '507f1f77bcf86cd799439099',
          organization: orgId,
          ledger: [],
          cachedBalance: 0,
          cachedBalanceAt: new Date(),
        };
        const updatedDoc = { ...existingDoc, cachedBalance: -100 };
        mockModelWithOrg.findOneAndUpdate
          .mockResolvedValueOnce(null) // upsert (no-op)
          .mockResolvedValueOnce(updatedDoc); // debit

        const result = await BillingExtraBalanceRepositoryWithOrg.debit(orgId, 100, 'ref_existing_org');

        expect(result.applied).toBe(true);
        // Org check must NOT be called when doc already exists
        expect(mockOrgRepository.exists).not.toHaveBeenCalled();
      });

      test('debit for non-existent org (no Organization + no Subscription) — throws AppError (status 404)', async () => {
        // No existing balance doc, no Organization doc, no Subscription doc → throws
        mockModelWithOrg.exists
          .mockResolvedValueOnce(null)  // BillingExtraBalance.exists → no doc
          .mockResolvedValueOnce(null); // Subscription.exists → no sub
        mockOrgRepository.exists.mockResolvedValue(null); // org not found

        await expect(
          BillingExtraBalanceRepositoryWithOrg.debit(orgId, 100, 'ref_ghost_org'),
        ).rejects.toMatchObject({ status: 404 });

        // No doc should be created
        expect(mockModelWithOrg.findOneAndUpdate).not.toHaveBeenCalled();
      });

      test('debit for org with Subscription but no Organization doc — succeeds (provisioning path)', async () => {
        // Subscription exists → org is real → allow debit even without an Org doc
        mockModelWithOrg.exists
          .mockResolvedValueOnce(null)                 // BillingExtraBalance.exists → no doc
          .mockResolvedValueOnce({ _id: 'sub_001' });  // Subscription.exists → exists
        mockOrgRepository.exists.mockResolvedValue(null); // no Organization doc

        const updatedDoc = {
          _id: '507f1f77bcf86cd799439099',
          organization: orgId,
          ledger: [{ kind: 'debit', amount: -100, refId: 'ref_sub_only_org' }],
          cachedBalance: -100,
          cachedBalanceAt: new Date(),
        };
        mockModelWithOrg.findOneAndUpdate
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepositoryWithOrg.debit(orgId, 100, 'ref_sub_only_org');
        expect(result.applied).toBe(true);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // creditCompensation (Item 1 support — Batch 2)
    // ─────────────────────────────────────────────────────────────────────────────
    describe('creditCompensation:', () => {
      test('should apply credit with adjustment kind and return applied:true', async () => {
        const updatedDoc = makeDoc({
          cachedBalance: 2000,
          ledger: [{ kind: 'adjustment', amount: 2000, refId: 'dispute-credit-abc' }],
        });
        // Step 1: getOrCreate; Step 2: credit
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepository.creditCompensation(orgId, 2000, 'dispute-credit-abc');

        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(2000);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });

      test('should return applied:false with reason duplicate_refId when refId already used', async () => {
        // Step 1: getOrCreate; Step 2: idempotency filter excludes → null
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(null);

        const result = await BillingExtraBalanceRepository.creditCompensation(orgId, 1000, 'already-used-ref');

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('duplicate_refId');
      });

      test('should throw on zero amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditCompensation(orgId, 0, 'ref_zero'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on negative amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditCompensation(orgId, -100, 'ref_neg'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on empty refId', async () => {
        await expect(
          BillingExtraBalanceRepository.creditCompensation(orgId, 100, ''),
        ).rejects.toThrow('invalid argument: refId must be a non-empty string');
      });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // creditGrant — signup grant (no stripeSessionId)
    // ─────────────────────────────────────────────────────────────────────────────
    describe('creditGrant:', () => {
      test('should apply grant with topup kind and return applied:true', async () => {
        const updatedDoc = makeDoc({
          cachedBalance: 500,
          ledger: [{ kind: 'topup', amount: 500, refId: 'signup_grant-507f1f77bcf86cd799439011' }],
        });
        // Step 1: getOrCreate; Step 2: idempotency-guarded credit
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(updatedDoc);

        const result = await BillingExtraBalanceRepository.creditGrant(orgId, 500, 'signup_grant');

        expect(result.applied).toBe(true);
        expect(result.doc.cachedBalance).toBe(500);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });

      test('should return applied:false with reason duplicate_grant when idempotency key already used', async () => {
        // Step 1: getOrCreate; Step 2: idempotency filter excludes → null (already credited)
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockResolvedValueOnce(null);

        const result = await BillingExtraBalanceRepository.creditGrant(orgId, 500, 'signup_grant');

        expect(result.applied).toBe(false);
        expect(result.reason).toBe('duplicate_grant');
        expect(result.doc).toBeNull();
      });

      test('step 2 filter uses refId derived from source+orgId for idempotency', async () => {
        const updatedDoc = makeDoc({ cachedBalance: 500 });
        let step2Filter;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockImplementation((filter) => {
            step2Filter = filter;
            return Promise.resolve(updatedDoc);
          });

        await BillingExtraBalanceRepository.creditGrant(orgId, 500, 'signup_grant');

        expect(step2Filter).toMatchObject({
          organization: orgId,
          'ledger.refId': { $ne: `signup_grant-${orgId}` },
        });
      });

      test('step 1 issues upsert getOrCreate (fresh org support)', async () => {
        let step1Options;
        let step1Update;
        const updatedDoc = makeDoc({ cachedBalance: 500 });
        mockModel.findOneAndUpdate.mockImplementation((filter, update, options) => {
          if (!step1Options) {
            step1Options = options;
            step1Update = update;
            return Promise.resolve(null);
          }
          return Promise.resolve(updatedDoc);
        });

        await BillingExtraBalanceRepository.creditGrant(orgId, 500, 'signup_grant');

        expect(step1Options?.upsert).toBe(true);
        expect(step1Update.$setOnInsert).toMatchObject({ organization: orgId, ledger: [], cachedBalance: 0 });
      });

      test('step 2 does NOT include upsert (doc guaranteed by step 1)', async () => {
        let step2Options;
        mockModel.findOneAndUpdate
          .mockResolvedValueOnce(makeDoc())
          .mockImplementation((filter, update, options) => {
            step2Options = options;
            return Promise.resolve(makeDoc({ cachedBalance: 500 }));
          });

        await BillingExtraBalanceRepository.creditGrant(orgId, 500, 'signup_grant');

        expect(step2Options?.upsert).toBeFalsy();
      });

      test('should throw on zero amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditGrant(orgId, 0, 'signup_grant'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on negative amount', async () => {
        await expect(
          BillingExtraBalanceRepository.creditGrant(orgId, -100, 'signup_grant'),
        ).rejects.toThrow('invalid argument: amount must be a positive finite number');
      });

      test('should throw on empty source', async () => {
        await expect(
          BillingExtraBalanceRepository.creditGrant(orgId, 500, ''),
        ).rejects.toThrow('invalid argument: source must be a non-empty string');
      });

      test('should throw (Zod) on source value not in allowed enum', async () => {
        await expect(
          BillingExtraBalanceRepository.creditGrant(orgId, 500, 'freebie'),
        ).rejects.toThrow();
        expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
      });

      test('should return null doc with applied:false for invalid orgId', async () => {
        const { default: mongoose } = await import('mongoose');
        mongoose.Types.ObjectId.isValid = jest.fn(() => false);

        const result = await BillingExtraBalanceRepository.creditGrant('bad-id', 500, 'signup_grant');
        expect(result).toEqual({ doc: null, applied: false });
        expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });
  });
});

// ─── ExtraBalanceCreditGrant schema tests ───────────────────────────────────────
describe('ExtraBalanceCreditGrant schema:', () => {
  let schema;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../models/billing.extraBalance.schema.js');
    schema = mod.default;
  });

  test('should be valid without stripeSessionId', () => {
    const result = schema.ExtraBalanceCreditGrant.safeParse({
      orgId: '507f1f77bcf86cd799439011',
      amount: 500,
      source: 'signup_grant',
    });
    expect(result.error).toBeFalsy();
    expect(result.data.source).toBe('signup_grant');
  });

  test('should accept valid source values', () => {
    for (const source of ['signup_grant', 'adjustment']) {
      const result = schema.ExtraBalanceCreditGrant.safeParse({
        orgId: '507f1f77bcf86cd799439011',
        amount: 500,
        source,
      });
      expect(result.error).toBeFalsy();
    }
  });

  test('should reject amount of 0', () => {
    const result = schema.ExtraBalanceCreditGrant.safeParse({
      orgId: '507f1f77bcf86cd799439011',
      amount: 0,
      source: 'signup_grant',
    });
    expect(result.error).toBeDefined();
  });

  test('should reject invalid orgId', () => {
    const result = schema.ExtraBalanceCreditGrant.safeParse({
      orgId: 'not-valid',
      amount: 500,
      source: 'signup_grant',
    });
    expect(result.error).toBeDefined();
  });

  test('should reject unknown source value', () => {
    const result = schema.ExtraBalanceCreditGrant.safeParse({
      orgId: '507f1f77bcf86cd799439011',
      amount: 500,
      source: 'freebie',
    });
    expect(result.error).toBeDefined();
  });
});
