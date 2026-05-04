/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for updateIfEventNewer per-family guard (Item 4 of billing webhook hardening).
 * Kept in a dedicated file to avoid Jest ESM mock cross-contamination with other describe
 * blocks that also mock 'mongoose' — re-registration within a single file can be unreliable
 * with unstable_mockModule when multiple factories for the same module are registered.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Item 4 — Per-family event-newer guards (subscription vs invoice)
// ─────────────────────────────────────────────────────────────────────────────
describe('updateIfEventNewer — per-family guard:', () => {
  let SubscriptionRepository;
  let mockModel;

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ _id: 'sub_1' }),
      }),
      find: jest.fn(),
      findOne: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockModel),
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
      },
    }));

    const mod = await import('../repositories/billing.subscription.repository.js');
    SubscriptionRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('family=subscription: $set writes lastSubscriptionEventCreatedAt and lastSubscriptionEventId', async () => {
    await SubscriptionRepository.updateIfEventNewer('507f1f77bcf86cd799439011', 100, 'evt_1', { plan: 'pro' }, 'subscription');

    expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockModel.findOneAndUpdate.mock.calls[0];

    // Guard reads the subscription-family field
    const orConditions = filter.$or;
    const hasSubField = orConditions.some((c) => 'lastSubscriptionEventCreatedAt' in c);
    expect(hasSubField).toBe(true);

    // Write targets the subscription-family field
    expect(update.$set.lastSubscriptionEventCreatedAt).toBe(100);
    expect(update.$set.lastSubscriptionEventId).toBe('evt_1');
    // Legacy fields also updated for back-compat
    expect(update.$set.stripeEventCreatedAt).toBe(100);
    expect(update.$set.stripeEventId).toBe('evt_1');
    // Invoice-family fields not touched
    expect(update.$set.lastInvoiceEventCreatedAt).toBeUndefined();
  });

  test('family=invoice: $set writes lastInvoiceEventCreatedAt and lastInvoiceEventId', async () => {
    await SubscriptionRepository.updateIfEventNewer('507f1f77bcf86cd799439011', 200, 'evt_2', { status: 'active' }, 'invoice');

    expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockModel.findOneAndUpdate.mock.calls[0];

    // Guard reads the invoice-family field
    const orConditions = filter.$or;
    const hasInvoiceField = orConditions.some((c) => 'lastInvoiceEventCreatedAt' in c);
    expect(hasInvoiceField).toBe(true);

    // Write targets the invoice-family field
    expect(update.$set.lastInvoiceEventCreatedAt).toBe(200);
    expect(update.$set.lastInvoiceEventId).toBe('evt_2');
    // Subscription-family fields not touched
    expect(update.$set.lastSubscriptionEventCreatedAt).toBeUndefined();
  });

  test('default family is subscription when not passed', async () => {
    await SubscriptionRepository.updateIfEventNewer('507f1f77bcf86cd799439011', 300, 'evt_3', { plan: 'free' });

    expect(mockModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.lastSubscriptionEventCreatedAt).toBe(300);
    expect(update.$set.lastInvoiceEventCreatedAt).toBeUndefined();
  });
});
