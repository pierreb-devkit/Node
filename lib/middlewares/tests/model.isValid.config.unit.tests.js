/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';
import { z } from 'zod';

import config from '../../../config/index.js';
import model from '../model.js';

/**
 * Runs `model.isValid` against the REAL default config (no config mock), so a
 * method dropped from `validation.supportedMethods` makes these tests fail.
 */
describe('model.isValid with the real config', () => {
  const schema = z.object({ planId: z.enum(['free', 'pro']), note: z.string().default('') }).strict();

  /**
   * Build a minimal Express response double.
   * @returns {{status: Function, json: Function}} Response mock.
   */
  const mockRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  test('validates PATCH bodies', () => {
    expect(config.validation.supportedMethods).toEqual(expect.arrayContaining(['post', 'put', 'patch']));
  });

  test('rejects an invalid PATCH body with 422', () => {
    const res = mockRes();
    const next = jest.fn();

    model.isValid(schema)({ method: 'PATCH', body: { planId: 'gold' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('keeps only the sent keys of a valid PATCH body', () => {
    const req = { method: 'PATCH', body: { planId: 'pro' } };
    const next = jest.fn();

    model.isValid(schema)(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ planId: 'pro' });
  });
});
