/**
 * Unit tests — audit stats controller error path: a failed read answers 500 with a
 * fixed message and logs the cause.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockLoggerError = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockLoggerError, warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockAdminStats = jest.fn();
const mockList = jest.fn();
jest.unstable_mockModule('../services/audit.service.js', () => ({
  default: { adminStats: mockAdminStats, list: mockList },
}));

const { default: controller } = await import('../controllers/audit.controller.js');
const { default: AppError } = await import('../../../lib/helpers/AppError.js');

const buildRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('audit stats controller', () => {
  test('should answer 500 and log the cause when the stats read fails', async () => {
    mockAdminStats.mockRejectedValueOnce(new Error('aggregate failed'));
    const res = buildRes();
    await controller.stats({}, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].description).toBe('Unable to compute audit stats');
    expect(mockLoggerError).toHaveBeenCalledWith('[stats] audit stats failed', expect.objectContaining({ message: 'aggregate failed' }));
  });
});

describe('audit list controller — error status (#4304)', () => {
  test('should answer the status an AppError carries (403), not a fixed 422', async () => {
    mockList.mockRejectedValueOnce(new AppError('Forbidden', { status: 403, code: 'FORBIDDEN' }));
    const res = buildRes();
    await controller.list({ query: {} }, res);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({ message: 'Forbidden', errorCode: 'FORBIDDEN' });
  });

  test('should answer 500 for an unexpected error', async () => {
    mockList.mockRejectedValueOnce(new Error('db down'));
    const res = buildRes();
    await controller.list({ query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
