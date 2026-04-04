/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for Webhook service
 */
describe('Developers Webhook service unit tests:', () => {
  let WebhookService;
  let mockWebhookRepository;
  let mockDeliveryRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const userId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockWebhookRepository = {
      create: jest.fn(),
      list: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      findByEvent: jest.fn(),
    };

    mockDeliveryRepository = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    jest.unstable_mockModule('../repositories/developers.webhook.repository.js', () => ({
      default: mockWebhookRepository,
    }));

    jest.unstable_mockModule('../repositories/developers.webhookDelivery.repository.js', () => ({
      default: mockDeliveryRepository,
    }));

    const mod = await import('../services/developers.webhook.service.js');
    WebhookService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    test('should create a webhook with a generated secret', async () => {
      const mockUser = { _id: userId };
      mockWebhookRepository.create.mockResolvedValue({
        toJSON: () => ({
          id: 'wh1',
          url: 'https://example.com/hook',
          events: ['scrap.success'],
          secret: 'whsec_test',
          active: true,
        }),
      });

      const result = await WebhookService.create(
        { url: 'https://example.com/hook', events: ['scrap.success'] },
        mockUser,
        orgId,
      );

      expect(mockWebhookRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user: userId,
          organizationId: orgId,
          url: 'https://example.com/hook',
          events: ['scrap.success'],
          active: true,
          secret: expect.stringContaining('whsec_'),
        }),
      );
      expect(result.plainSecret).toBeDefined();
      expect(result.plainSecret).toMatch(/^whsec_/);
    });
  });

  describe('list', () => {
    test('should delegate to repository with org and pagination', async () => {
      mockWebhookRepository.list.mockResolvedValue({ data: [], total: 0 });

      const result = await WebhookService.list(orgId, 1, 20);

      expect(mockWebhookRepository.list).toHaveBeenCalledWith(orgId, 1, 20);
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('get', () => {
    test('should delegate to repository', async () => {
      mockWebhookRepository.get.mockResolvedValue({ id: 'wh1' });

      const result = await WebhookService.get('wh1');

      expect(mockWebhookRepository.get).toHaveBeenCalledWith('wh1');
      expect(result).toEqual({ id: 'wh1' });
    });
  });

  describe('update', () => {
    test('should merge body fields onto webhook and save', async () => {
      const webhook = {
        url: 'https://old.com',
        events: ['scrap.success'],
        active: true,
        description: '',
      };
      mockWebhookRepository.update.mockResolvedValue({ ...webhook, active: false });

      const result = await WebhookService.update(webhook, { active: false });

      expect(webhook.active).toBe(false);
      expect(mockWebhookRepository.update).toHaveBeenCalledWith(webhook);
      expect(result.active).toBe(false);
    });

    test('should update url if provided', async () => {
      const webhook = { url: 'https://old.com' };
      mockWebhookRepository.update.mockResolvedValue({ ...webhook, url: 'https://new.com' });

      await WebhookService.update(webhook, { url: 'https://new.com' });

      expect(webhook.url).toBe('https://new.com');
    });

    test('should update events if provided', async () => {
      const webhook = { events: ['scrap.success'] };
      mockWebhookRepository.update.mockResolvedValue({ ...webhook, events: ['scrap.failure'] });

      await WebhookService.update(webhook, { events: ['scrap.failure'] });

      expect(webhook.events).toEqual(['scrap.failure']);
    });
  });

  describe('remove', () => {
    test('should delegate to repository', async () => {
      mockWebhookRepository.remove.mockResolvedValue({ _id: 'wh1' });

      const result = await WebhookService.remove('wh1');

      expect(mockWebhookRepository.remove).toHaveBeenCalledWith('wh1');
      expect(result._id).toBe('wh1');
    });
  });

  describe('listDeliveries', () => {
    test('should delegate to delivery repository with pagination', async () => {
      const webhookId = '607f1f77bcf86cd799439022';
      mockDeliveryRepository.list.mockResolvedValue({ data: [], total: 0 });

      const result = await WebhookService.listDeliveries(webhookId, 1, 20);

      expect(mockDeliveryRepository.list).toHaveBeenCalledWith(webhookId, 1, 20);
      expect(result).toEqual({ data: [], total: 0 });
    });
  });
});
