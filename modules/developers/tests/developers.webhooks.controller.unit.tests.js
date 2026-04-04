/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for Webhooks controller
 */
describe('Developers Webhooks controller unit tests:', () => {
  let controller;
  let mockWebhookService;
  let mockDispatchService;
  let mockResponses;
  let mockRes;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockWebhookService = {
      create: jest.fn(),
      list: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      listDeliveries: jest.fn(),
    };

    mockDispatchService = {
      sendTestPing: jest.fn(),
    };

    mockResponses = {
      success: jest.fn((res, msg) => (data) => ({ type: 'success', message: msg, data })),
      error: jest.fn((res, status, msg, desc) => () => ({ type: 'error', status, message: msg, description: desc })),
    };

    jest.unstable_mockModule('../services/developers.webhook.service.js', () => ({
      default: mockWebhookService,
    }));

    jest.unstable_mockModule('../services/developers.webhook.dispatch.service.js', () => ({
      default: mockDispatchService,
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: mockResponses,
    }));

    const mod = await import('../controllers/developers.webhooks.controller.js');
    controller = mod.default;

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    test('should call service with organization id and pagination', async () => {
      const req = { organization: { _id: orgId }, query: {} };
      mockWebhookService.list.mockResolvedValue({ data: [], total: 0 });

      await controller.list(req, mockRes);

      expect(mockWebhookService.list).toHaveBeenCalledWith(orgId, 1, 20);
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhooks');
    });

    test('should clamp negative page and perPage to safe values', async () => {
      const req = { organization: { _id: orgId }, query: { page: '-5', perPage: '-10' } };
      mockWebhookService.list.mockResolvedValue({ data: [], total: 0 });

      await controller.list(req, mockRes);

      expect(mockWebhookService.list).toHaveBeenCalledWith(orgId, 1, 1);
    });

    test('should cap perPage to 100', async () => {
      const req = { organization: { _id: orgId }, query: { perPage: '500' } };
      mockWebhookService.list.mockResolvedValue({ data: [], total: 0 });

      await controller.list(req, mockRes);

      expect(mockWebhookService.list).toHaveBeenCalledWith(orgId, 1, 100);
    });
  });

  describe('create', () => {
    test('should call service with body, user and org id', async () => {
      const req = {
        body: { url: 'https://example.com', events: ['scrap.success'] },
        user: { _id: 'user1' },
        organization: { _id: orgId },
      };
      mockWebhookService.create.mockResolvedValue({ id: 'wh1' });

      await controller.create(req, mockRes);

      expect(mockWebhookService.create).toHaveBeenCalledWith(
        req.body,
        { _id: 'user1' },
        orgId,
      );
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhook created');
    });
  });

  describe('get', () => {
    test('should return the loaded webhook from req via responses.success', () => {
      const webhook = { _id: 'wh1', url: 'https://example.com' };
      const req = { webhook };

      controller.get(req, mockRes);

      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhook');
    });
  });

  describe('update', () => {
    test('should call service with webhook and body', async () => {
      const webhook = { _id: 'wh1', url: 'https://old.com' };
      const req = { webhook, body: { active: false } };
      mockWebhookService.update.mockResolvedValue({ ...webhook, active: false });

      await controller.update(req, mockRes);

      expect(mockWebhookService.update).toHaveBeenCalledWith(webhook, { active: false });
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhook updated');
    });
  });

  describe('remove', () => {
    test('should call service with webhook id', async () => {
      const req = { webhook: { _id: 'wh1' } };
      mockWebhookService.remove.mockResolvedValue({ _id: 'wh1' });

      await controller.remove(req, mockRes);

      expect(mockWebhookService.remove).toHaveBeenCalledWith('wh1');
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhook deleted');
    });
  });

  describe('listDeliveries', () => {
    test('should call service with webhook id and pagination', async () => {
      const req = { webhook: { _id: 'wh1' }, query: {} };
      mockWebhookService.listDeliveries.mockResolvedValue({ data: [], total: 0 });

      await controller.listDeliveries(req, mockRes);

      expect(mockWebhookService.listDeliveries).toHaveBeenCalledWith('wh1', 1, 20);
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'webhook deliveries');
    });
  });

  describe('testPing', () => {
    test('should call dispatch service with webhook', async () => {
      const webhook = { _id: 'wh1', url: 'https://example.com' };
      const req = { webhook };
      mockDispatchService.sendTestPing.mockResolvedValue({ _id: 'd1', event: 'ping' });

      await controller.testPing(req, mockRes);

      expect(mockDispatchService.sendTestPing).toHaveBeenCalledWith(webhook);
      expect(mockResponses.success).toHaveBeenCalledWith(mockRes, 'test ping sent');
    });
  });

  describe('webhookByID', () => {
    test('should load webhook and attach to req', async () => {
      const req = {};
      const next = jest.fn();
      mockWebhookService.get.mockResolvedValue({ _id: 'wh1', url: 'https://example.com' });

      await controller.webhookByID(req, mockRes, next, 'wh1');

      expect(req.webhook).toEqual({ _id: 'wh1', url: 'https://example.com' });
      expect(next).toHaveBeenCalled();
    });

    test('should return 404 when webhook not found', async () => {
      const req = {};
      const next = jest.fn();
      mockWebhookService.get.mockResolvedValue(null);

      await controller.webhookByID(req, mockRes, next, 'wh1');

      expect(next).not.toHaveBeenCalled();
      expect(mockResponses.error).toHaveBeenCalledWith(mockRes, 404, 'Not Found', 'No webhook with that identifier has been found');
    });
  });
});
