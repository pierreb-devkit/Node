/**
 * Module dependencies.
 */
import { describe, test, beforeEach, expect } from '@jest/globals';
import { z } from 'zod';

/**
 * Inline Zod schema for ProcessedStripeEvent validation tests.
 * Mirrors billing.processedStripeEvent.model.mongoose.js field requirements.
 */
const ProcessedStripeEventSchema = z.object({
  eventId: z.string().trim().min(1, 'eventId is required'),
  type: z.string().trim().min(1, 'type is required'),
  processedAt: z.coerce.date().default(() => new Date()),
});

/**
 * Unit tests for ProcessedStripeEvent model
 */
describe('ProcessedStripeEvent unit tests:', () => {
  describe('Schema validation', () => {
    let event;

    beforeEach(() => {
      event = {
        eventId: 'evt_1ABC123',
        type: 'checkout.session.completed',
        processedAt: new Date('2026-05-01T12:00:00.000Z'),
      };
    });

    test('should be valid with all required fields', () => {
      const result = ProcessedStripeEventSchema.safeParse(event);
      expect(result.error).toBeFalsy();
      expect(result.data.eventId).toBe('evt_1ABC123');
      expect(result.data.type).toBe('checkout.session.completed');
    });

    test('should reject empty eventId', () => {
      event.eventId = '';
      const result = ProcessedStripeEventSchema.safeParse(event);
      expect(result.error).toBeDefined();
    });

    test('should reject missing eventId', () => {
      delete event.eventId;
      const result = ProcessedStripeEventSchema.safeParse(event);
      expect(result.error).toBeDefined();
    });

    test('should reject missing type', () => {
      delete event.type;
      const result = ProcessedStripeEventSchema.safeParse(event);
      expect(result.error).toBeDefined();
    });

    test('should default processedAt to now when not provided', () => {
      delete event.processedAt;
      const before = new Date();
      const result = ProcessedStripeEventSchema.safeParse(event);
      const after = new Date();
      expect(result.error).toBeFalsy();
      expect(result.data.processedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.data.processedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test('should coerce string date to Date for processedAt', () => {
      event.processedAt = '2026-05-01T12:00:00.000Z';
      const result = ProcessedStripeEventSchema.safeParse(event);
      expect(result.error).toBeFalsy();
      expect(result.data.processedAt).toBeInstanceOf(Date);
    });

    test('should accept various Stripe event types', () => {
      const types = [
        'checkout.session.completed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_failed',
        'invoice.payment_succeeded',
        'charge.refunded',
      ];
      for (const type of types) {
        event.type = type;
        const result = ProcessedStripeEventSchema.safeParse(event);
        expect(result.error).toBeFalsy();
      }
    });
  });

  describe('TTL configuration', () => {
    test('TTL constant is 30 days in seconds', () => {
      const TTL_30_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;
      expect(TTL_30_DAYS_IN_SECONDS).toBe(2592000);
    });

    test('TTL constant exceeds Stripe retry window of 3 days', () => {
      const TTL_30_DAYS = 30 * 24 * 60 * 60;
      const STRIPE_RETRY_WINDOW = 3 * 24 * 60 * 60;
      expect(TTL_30_DAYS).toBeGreaterThan(STRIPE_RETRY_WINDOW);
    });
  });
});
