/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock config
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    validation: { supportedMethods: ['post', 'put', 'patch'] },
    whitelists: { users: { default: [] } },
  },
}));

// Mock responses
jest.unstable_mockModule('../../helpers/responses.js', () => ({
  default: {
    error: jest.fn(() => jest.fn()),
  },
}));

const { default: model } = await import('../model.js');
const { default: responses } = await import('../../helpers/responses.js');

/**
 * Helper: build a mock Zod-like schema whose safeParse returns given data
 * with extra default-injected keys (simulates .partial() + .default(''))
 */
const mockSchema = (extraDefaults) => ({
  safeParse: jest.fn((body) => ({
    success: true,
    data: { ...body, ...extraDefaults },
  })),
});

/** Helper: build a failing schema */
const failingSchema = () => ({
  safeParse: jest.fn(() => ({
    success: false,
    error: {
      issues: [{ message: 'too short', code: 'too_small' }],
    },
  })),
});

describe('model.isValid – preserve original body keys', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    res = {};
    next = jest.fn();
    jest.clearAllMocks();
  });

  test('should not inject Zod defaults for absent keys on partial updates', () => {
    const schema = mockSchema({ url: '', banner: '', description: '' });
    req = { method: 'PUT', body: { request: 'test-value' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ request: 'test-value' });
    expect(req.body).not.toHaveProperty('url');
    expect(req.body).not.toHaveProperty('banner');
    expect(req.body).not.toHaveProperty('description');
  });

  test('should keep all keys when client sends them explicitly', () => {
    const schema = mockSchema({ description: '' });
    req = { method: 'PUT', body: { request: 'val', url: 'https://x.com', banner: '' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ request: 'val', url: 'https://x.com', banner: '' });
    expect(req.body).not.toHaveProperty('description');
  });

  test('should use Zod-transformed values for present keys', () => {
    const schema = {
      safeParse: jest.fn((body) => ({
        success: true,
        data: { name: body.name.trim(), extra: 'injected' },
      })),
    };
    req = { method: 'POST', body: { name: '  hello  ' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'hello' });
    expect(req.body).not.toHaveProperty('extra');
  });

  test('should skip validation for unsupported HTTP methods', () => {
    const schema = mockSchema({});
    req = { method: 'GET', body: { request: 'test' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(schema.safeParse).not.toHaveBeenCalled();
    expect(req.body).toEqual({ request: 'test' });
  });

  test('should return 422 on validation error', () => {
    const schema = failingSchema();
    req = { method: 'POST', body: { name: 'ab' } };

    model.isValid(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(responses.error).toHaveBeenCalledWith(res, 422, 'Schema validation error', expect.any(String));
  });
});
