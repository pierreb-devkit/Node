/**
 * Module dependencies.
 */
import schema from '../models/developers.webhook.schema.js';

/**
 * Unit tests
 */
describe('Developers Webhook schema unit tests:', () => {
  describe('WebhookCreate schema', () => {
    test('should accept a valid webhook', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: ['scrap.success'],
      });
      expect(result.error).toBeFalsy();
      expect(result.data.url).toBe('https://example.com/hook');
      expect(result.data.events).toEqual(['scrap.success']);
      done();
    });

    test('should accept multiple valid events', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: ['scrap.success', 'scrap.failure'],
      });
      expect(result.error).toBeFalsy();
      expect(result.data.events).toEqual(['scrap.success', 'scrap.failure']);
      done();
    });

    test('should accept optional description', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: ['scrap.success'],
        description: 'My webhook',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.description).toBe('My webhook');
      done();
    });

    test('should reject non-HTTPS URL', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'http://example.com/hook',
        events: ['scrap.success'],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject invalid URL', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'not-a-url',
        events: ['scrap.success'],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject empty events array', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: [],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject invalid event name', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: ['invalid_event'],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject when url is missing', (done) => {
      const result = schema.WebhookCreate.safeParse({
        events: ['scrap.success'],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject when events is missing', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject unknown fields', (done) => {
      const result = schema.WebhookCreate.safeParse({
        url: 'https://example.com/hook',
        events: ['scrap.success'],
        unknown: 'field',
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should accept all supported events', (done) => {
      for (const event of schema.supportedEvents) {
        const result = schema.WebhookCreate.safeParse({
          url: 'https://example.com/hook',
          events: [event],
        });
        expect(result.error).toBeFalsy();
      }
      done();
    });
  });

  describe('WebhookUpdate schema', () => {
    test('should accept partial update with url only', (done) => {
      const result = schema.WebhookUpdate.safeParse({
        url: 'https://example.com/new-hook',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.url).toBe('https://example.com/new-hook');
      done();
    });

    test('should accept partial update with active only', (done) => {
      const result = schema.WebhookUpdate.safeParse({ active: false });
      expect(result.error).toBeFalsy();
      expect(result.data.active).toBe(false);
      done();
    });

    test('should accept partial update with events only', (done) => {
      const result = schema.WebhookUpdate.safeParse({
        events: ['scrap.failure'],
      });
      expect(result.error).toBeFalsy();
      expect(result.data.events).toEqual(['scrap.failure']);
      done();
    });

    test('should accept partial update with description', (done) => {
      const result = schema.WebhookUpdate.safeParse({
        description: 'Updated description',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.description).toBe('Updated description');
      done();
    });

    test('should accept empty object', (done) => {
      const result = schema.WebhookUpdate.safeParse({});
      expect(result.error).toBeFalsy();
      done();
    });

    test('should reject invalid URL in update', (done) => {
      const result = schema.WebhookUpdate.safeParse({ url: 'bad' });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject non-HTTPS URL in update', (done) => {
      const result = schema.WebhookUpdate.safeParse({ url: 'http://example.com/hook' });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject invalid event in update', (done) => {
      const result = schema.WebhookUpdate.safeParse({
        events: ['not_real'],
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject unknown fields', (done) => {
      const result = schema.WebhookUpdate.safeParse({
        url: 'https://example.com/hook',
        secret: 'override',
      });
      expect(result.error).toBeDefined();
      done();
    });
  });
});
