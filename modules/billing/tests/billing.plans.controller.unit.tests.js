/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

describe('Billing plans controller unit tests:', () => {
  let BillingPlansController;
  let mockBillingPlansService;
  let res;

  beforeEach(async () => {
    jest.resetModules();

    mockBillingPlansService = {
      getPlans: jest.fn(),
    };

    jest.unstable_mockModule('../services/billing.plans.service.js', () => ({
      default: mockBillingPlansService,
    }));

    const mod = await import('../controllers/billing.plans.controller.js');
    BillingPlansController = mod.default;

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('getPlans returns billing plans on success', async () => {
    const plans = [{ planId: 'free', monthlyPrice: 0 }];
    mockBillingPlansService.getPlans.mockResolvedValue(plans);

    await BillingPlansController.getPlans({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'billing plans',
      data: plans,
    }));
  });

  test('getPlans returns error envelope when Stripe is unavailable', async () => {
    mockBillingPlansService.getPlans.mockRejectedValue(new Error('Stripe down'));

    await BillingPlansController.getPlans({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Internal Server Error',
      description: 'Failed to retrieve billing plans',
    }));
  });
});
