/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for Webhook dispatch service
 */
describe('Developers Webhook dispatch service unit tests:', () => {
  let DispatchService;
  let mockWebhookRepository;
  let mockDeliveryRepository;
  let mockFetch;

  const orgId = '507f1f77bcf86cd799439099';

  beforeEach(async () => {
    jest.resetModules();

    mockWebhookRepository = {
      findByEvent: jest.fn(),
      findActiveByEvent: jest.fn(),
      get: jest.fn(),
    };

    mockDeliveryRepository = {
      create: jest.fn(),
      update: jest.fn(),
      findPendingRetries: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/developers.webhook.repository.js', () => ({
      default: mockWebhookRepository,
    }));

    jest.unstable_mockModule('../repositories/developers.webhookDelivery.repository.js', () => ({
      default: mockDeliveryRepository,
    }));

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    const mod = await import('../services/developers.webhook.dispatch.service.js');
    DispatchService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  describe('signPayload', () => {
    test('should produce a consistent HMAC-SHA256 signature', () => {
      const payload = '{"event":"scrap.success"}';
      const secret = 'test_secret';

      const sig1 = DispatchService.signPayload(payload, secret);
      const sig2 = DispatchService.signPayload(payload, secret);

      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('should produce different signatures for different secrets', () => {
      const payload = '{"event":"scrap.success"}';

      const sig1 = DispatchService.signPayload(payload, 'secret1');
      const sig2 = DispatchService.signPayload(payload, 'secret2');

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('deliverWebhook', () => {
    const webhook = {
      _id: 'wh1',
      url: 'https://example.com/hook',
      secret: 'whsec_test123',
      organizationId: orgId,
    };

    test('should POST to webhook url with correct headers on success', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: { scrapId: 's1' },
        organizationId: orgId,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.create.mockResolvedValue(delivery);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      const result = await DispatchService.deliverWebhook(webhook, 'scrap.success', { scrapId: 's1' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Webhook-Event': 'scrap.success',
          }),
        }),
      );

      // Check the X-Signature-256 header format
      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.headers['X-Signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attempts).toBe(1);
      expect(result.nextRetryAt).toBeUndefined();
    });

    test('should set nextRetryAt on non-2xx response', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        organizationId: orgId,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.create.mockResolvedValue(delivery);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await DispatchService.deliverWebhook(webhook, 'scrap.success', {});

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.nextRetryAt).toBeDefined();
      expect(result.nextRetryAt).toBeInstanceOf(Date);
    });

    test('should handle fetch error and set nextRetryAt', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        organizationId: orgId,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.create.mockResolvedValue(delivery);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await DispatchService.deliverWebhook(webhook, 'scrap.success', {});

      expect(result.success).toBe(false);
      expect(result.responseBody).toBe('Connection refused');
      expect(result.nextRetryAt).toBeDefined();
    });

    test('should truncate response body to 1000 chars', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        organizationId: orgId,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.create.mockResolvedValue(delivery);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('x'.repeat(2000)),
      });

      const result = await DispatchService.deliverWebhook(webhook, 'scrap.success', {});

      expect(result.responseBody.length).toBe(1000);
    });
  });

  describe('dispatch', () => {
    test('should find webhooks by event and org and initiate delivery', async () => {
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        organizationId: orgId,
      };
      mockWebhookRepository.findByEvent.mockResolvedValue([webhook]);
      mockDeliveryRepository.create.mockResolvedValue({
        _id: 'd1',
        save: jest.fn().mockResolvedValue(true),
      });
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      await DispatchService.dispatch('scrap.success', { scrapId: 's1' }, orgId);

      expect(mockWebhookRepository.findByEvent).toHaveBeenCalledWith('scrap.success', orgId);
    });

    test('should do nothing when no webhooks match the event', async () => {
      mockWebhookRepository.findByEvent.mockResolvedValue([]);

      await DispatchService.dispatch('scrap.failure', { scrapId: 's1' }, orgId);

      expect(mockDeliveryRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('retryPending', () => {
    test('should find pending retries and re-deliver', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: { scrapId: 's1' },
        attempts: 1,
        save: jest.fn().mockResolvedValue(true),
      };
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        active: true,
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue(webhook);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      await DispatchService.retryPending();

      expect(mockDeliveryRepository.findPendingRetries).toHaveBeenCalled();
      expect(mockWebhookRepository.get).toHaveBeenCalledWith('wh1');
      expect(mockFetch).toHaveBeenCalled();
      expect(delivery.attempts).toBe(2);
      expect(delivery.success).toBe(true);
    });

    test('should finalize and skip inactive webhooks on retry', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        attempts: 1,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue({ _id: 'wh1', active: false });
      mockDeliveryRepository.update.mockImplementation((d) => d.save());

      await DispatchService.retryPending();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(delivery.nextRetryAt).toBeNull();
      expect(mockDeliveryRepository.update).toHaveBeenCalledWith(delivery);
    });

    test('should finalize when webhook no longer exists', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        attempts: 1,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue(null);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());

      await DispatchService.retryPending();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(delivery.nextRetryAt).toBeNull();
      expect(mockDeliveryRepository.update).toHaveBeenCalledWith(delivery);
    });

    test('should handle fetch error on retry', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        attempts: 1,
        save: jest.fn().mockResolvedValue(true),
      };
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        active: true,
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue(webhook);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockRejectedValue(new Error('Timeout'));

      await DispatchService.retryPending();

      expect(delivery.attempts).toBe(2);
      expect(delivery.success).toBe(false);
      expect(delivery.nextRetryAt).toBeDefined();
    });

    test('should schedule retry on attempt 3 (third retry)', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        attempts: 2,
        save: jest.fn().mockResolvedValue(true),
      };
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        active: true,
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue(webhook);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Error'),
      });

      await DispatchService.retryPending();

      expect(delivery.attempts).toBe(3);
      // nextAttempt (3) <= MAX_RETRY_ATTEMPTS (3), so retry is still scheduled
      expect(delivery.nextRetryAt).toBeInstanceOf(Date);
    });

    test('should clear nextRetryAt after exceeding max attempts', async () => {
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'scrap.success',
        payload: {},
        attempts: 3,
        save: jest.fn().mockResolvedValue(true),
      };
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        active: true,
      };
      mockDeliveryRepository.findPendingRetries.mockResolvedValue([delivery]);
      mockWebhookRepository.get.mockResolvedValue(webhook);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Error'),
      });

      await DispatchService.retryPending();

      expect(delivery.attempts).toBe(4);
      expect(delivery.nextRetryAt).toBeNull();
    });
  });

  describe('sendTestPing', () => {
    test('should deliver a ping event to the webhook', async () => {
      const webhook = {
        _id: 'wh1',
        url: 'https://example.com/hook',
        secret: 'whsec_test',
        organizationId: orgId,
      };
      const delivery = {
        _id: 'd1',
        webhook: 'wh1',
        event: 'ping',
        organizationId: orgId,
        save: jest.fn().mockResolvedValue(true),
      };
      mockDeliveryRepository.create.mockResolvedValue(delivery);
      mockDeliveryRepository.update.mockImplementation((d) => d.save());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('pong'),
      });

      const result = await DispatchService.sendTestPing(webhook);

      expect(mockDeliveryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          webhook: 'wh1',
          event: 'ping',
          organizationId: orgId,
        }),
      );
      expect(result.success).toBe(true);
    });
  });
});
