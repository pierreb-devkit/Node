/**
 * Unit tests — audit stats controller error path: a failed read answers 422 with a
 * fixed message and logs the cause.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockLoggerError = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockLoggerError, warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockAdminStats = jest.fn();
jest.unstable_mockModule('../services/audit.service.js', () => ({
  default: { adminStats: mockAdminStats },
}));

const { default: controller } = await import('../controllers/audit.controller.js');

const buildRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('audit stats controller', () => {
  test('should answer 422 and log the cause when the stats read fails', async () => {
    mockAdminStats.mockRejectedValueOnce(new Error('aggregate failed'));
    const res = buildRes();
    await controller.stats({}, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].description).toBe('Unable to compute audit stats');
    expect(mockLoggerError).toHaveBeenCalledWith('[stats] audit stats failed', expect.objectContaining({ message: 'aggregate failed' }));
  });
});
