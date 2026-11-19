/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, expect } from '@jest/globals';

/**
 * Unit tests for the billing admin controller error status. The REAL
 * `lib/helpers/responses.js` is used (not mocked) so these prove the
 * controller's `err.status ?? 500` guard: a raw Stripe error's own
 * `statusCode` (e.g. 401 = our API key) must never reach the client.
 */
describe('Billing admin controller error status unit tests:', () => {
  let BillingAdminController;
  let mockBillingAdminService;
  let res;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @returns {Object} A mock res object with chainable methods.
   */
  const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingAdminService = {
      getCustomerStatus: jest.fn(),
      syncOrgFromStripe: jest.fn(),
      replayWebhookEvent: jest.fn(),
      cancelSubscription: jest.fn(),
    };

    jest.unstable_mockModule('../services/billing.admin.service.js', () => ({
      default: mockBillingAdminService,
    }));
    jest.unstable_mockModule('../lib/billing.stripe.js', () => ({
      default: jest.fn(),
    }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    }));

    const mod = await import('../controllers/billing.admin.controller.js');
    BillingAdminController = mod.default;
    res = makeRes();
  });

  const cases = [
    ['adminGetCustomerStatus', 'getCustomerStatus', { params: { orgId } }],
    ['adminSyncFromStripe', 'syncOrgFromStripe', { params: { orgId } }],
    ['adminReplayWebhook', 'replayWebhookEvent', { body: { eventId: 'evt_123' } }],
  ];

  test.each(cases)('%s answers 500 for a Stripe-like error carrying statusCode 401', async (handler, method, req) => {
    const stripeErr = Object.assign(new Error('Invalid API Key provided'), { statusCode: 401 });
    mockBillingAdminService[method].mockRejectedValue(stripeErr);

    await BillingAdminController[handler](req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 500, message: 'Internal Server Error' });
  });

  test.each(cases)('%s answers the error own status (502)', async (handler, method, req) => {
    const err = Object.assign(new Error('Stripe unreachable'), { status: 502 });
    mockBillingAdminService[method].mockRejectedValue(err);

    await BillingAdminController[handler](req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: 502, message: 'Bad Gateway' });
  });
});
