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
    test('should return { recorded: true } on first insert', async () => {
      mockModel.create.mockResolvedValue({ eventId: 'evt_abc', type: 'checkout.session.completed' });

      const result = await ProcessedStripeEventRepository.tryRecord('evt_abc', 'checkout.session.completed');

      expect(result).toEqual({ recorded: true });
      expect(mockModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'evt_abc', type: 'checkout.session.completed' }),
      );
    });

    test('should return { recorded: false } on duplicate eventId (E11000)', async () => {
      mockModel.create.mockRejectedValueOnce(makeE11000());

      const result = await ProcessedStripeEventRepository.tryRecord('evt_abc', 'checkout.session.completed');

      expect(result).toEqual({ recorded: false });
    });

    test('same eventId twice — second returns { recorded: false }', async () => {
      mockModel.create
        .mockResolvedValueOnce({ eventId: 'evt_dup', type: 'charge.refunded' })
        .mockRejectedValueOnce(makeE11000());

      const first = await ProcessedStripeEventRepository.tryRecord('evt_dup', 'charge.refunded');
      const second = await ProcessedStripeEventRepository.tryRecord('evt_dup', 'charge.refunded');

      expect(first).toEqual({ recorded: true });
      expect(second).toEqual({ recorded: false });
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
});
