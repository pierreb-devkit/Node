/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.processedStripeEvent.repository.js
 */
describe('ProcessedStripeEventRepository unit tests:', () => {
  let ProcessedStripeEventRepository;
  let mockModel;

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
      deleteOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/billing.processedStripeEvent.repository.js');
    ProcessedStripeEventRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('tryRecord', () => {
    /** Helper: stub findOne().lean() to return the given existing doc. */
    const stubExisting = (existing) => {
      mockModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(existing) });
    };

    test('should return { recorded: true, retry: false } on first insert', async () => {
      mockModel.create.mockResolvedValue({ eventId: 'evt_abc', type: 'checkout.session.completed' });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_abc', 'checkout.session.completed');

      expect(result).toEqual({ recorded: true, retry: false });
      expect(mockModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'evt_abc', type: 'checkout.session.completed' }),
      );
    });

    test('duplicate + existing.deadLetter=true → { recorded: false, reason: dead_letter }', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      stubExisting({ eventId: 'evt_dl', attempts: 5, deadLetter: true });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_dl', 'checkout.session.completed');

      expect(result).toEqual({ recorded: false, reason: 'dead_letter' });
    });

    test('duplicate + attempts>0 + !deadLetter → { recorded: true, retry: true } (in-flight retry)', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      stubExisting({ eventId: 'evt_retry', attempts: 2, deadLetter: false });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_retry', 'charge.refunded');

      expect(result).toEqual({ recorded: true, retry: true });
    });

    test('duplicate + attempts===0 + !deadLetter → { recorded: false, reason: already_processed } (terminal success)', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      stubExisting({ eventId: 'evt_done', attempts: 0, deadLetter: false });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_done', 'charge.refunded');

      expect(result).toEqual({ recorded: false, reason: 'already_processed' });
    });

    test('duplicate + missing-attempts field treated as 0 → already_processed', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      // Legacy doc with no attempts field at all
      stubExisting({ eventId: 'evt_legacy', deadLetter: false });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_legacy', 'charge.refunded');

      expect(result).toEqual({ recorded: false, reason: 'already_processed' });
    });

    test('duplicate + lookup returns null (race window) → already_processed', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());
      stubExisting(null);

      const result = await ProcessedStripeEventRepository.tryRecord('evt_gone', 'charge.refunded');

      expect(result).toEqual({ recorded: false, reason: 'already_processed' });
    });

    test('should throw for non-duplicate errors', async () => {
      const genericError = new Error('MongoDB connection lost');
      mockModel.create.mockRejectedValue(genericError);

      await expect(
        ProcessedStripeEventRepository.tryRecord('evt_abc', 'checkout.session.completed'),
      ).rejects.toThrow('MongoDB connection lost');
    });

    test('should throw for empty eventId', async () => {
      await expect(
        ProcessedStripeEventRepository.tryRecord('', 'checkout.session.completed'),
      ).rejects.toThrow('invalid argument: eventId must be a non-empty string');
    });

    test('should throw for non-string eventId', async () => {
      await expect(
        ProcessedStripeEventRepository.tryRecord(null, 'checkout.session.completed'),
      ).rejects.toThrow('invalid argument: eventId must be a non-empty string');
    });

    test('should throw for empty type', async () => {
      await expect(
        ProcessedStripeEventRepository.tryRecord('evt_abc', ''),
      ).rejects.toThrow('invalid argument: type must be a non-empty string');
    });

    test('should throw for non-string type', async () => {
      await expect(
        ProcessedStripeEventRepository.tryRecord('evt_abc', null),
      ).rejects.toThrow('invalid argument: type must be a non-empty string');
    });
  });

  describe('wasProcessed', () => {
    test('should return true when event exists', async () => {
      mockModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ eventId: 'evt_xyz', type: 'charge.refunded' }),
      });

      const result = await ProcessedStripeEventRepository.wasProcessed('evt_xyz');

      expect(result).toBe(true);
      expect(mockModel.findOne).toHaveBeenCalledWith({ eventId: 'evt_xyz' });
    });

    test('should return false when event does not exist', async () => {
      mockModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      const result = await ProcessedStripeEventRepository.wasProcessed('evt_missing');

      expect(result).toBe(false);
    });

    test('should return false for empty eventId', async () => {
      const result = await ProcessedStripeEventRepository.wasProcessed('');
      expect(result).toBe(false);
    });

    test('should return false for non-string eventId', async () => {
      const result = await ProcessedStripeEventRepository.wasProcessed(null);
      expect(result).toBe(false);
    });
  });

  describe('deleteByEventId', () => {
    test('returns { deleted: true } when document removed', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await ProcessedStripeEventRepository.deleteByEventId('evt_to_delete');

      expect(result).toEqual({ deleted: true });
      expect(mockModel.deleteOne).toHaveBeenCalledWith({ eventId: 'evt_to_delete' });
    });

    test('returns { deleted: false } when document not found', async () => {
      mockModel.deleteOne.mockResolvedValue({ deletedCount: 0 });

      const result = await ProcessedStripeEventRepository.deleteByEventId('evt_missing');

      expect(result).toEqual({ deleted: false });
    });

    test('throws for empty eventId', async () => {
      await expect(
        ProcessedStripeEventRepository.deleteByEventId(''),
      ).rejects.toThrow('invalid argument: eventId must be a non-empty string');
    });

    test('throws for non-string eventId', async () => {
      await expect(
        ProcessedStripeEventRepository.deleteByEventId(null),
      ).rejects.toThrow('invalid argument: eventId must be a non-empty string');
    });

    test('propagates DB errors', async () => {
      mockModel.deleteOne.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        ProcessedStripeEventRepository.deleteByEventId('evt_abc'),
      ).rejects.toThrow('DB connection lost');
    });
  });
});
