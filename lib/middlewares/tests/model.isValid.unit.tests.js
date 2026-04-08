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
 * Build a mock Zod-like schema returning body merged with default-injected keys.
 * @param {Object<string, unknown>} extraDefaults - Default values to merge into parsed output.
 * @returns {{ safeParse: Function }} Mock schema with a safeParse function.
 */
const mockSchema = (extraDefaults) => ({
  safeParse: jest.fn((body) => ({
    success: true,
    data: { ...body, ...extraDefaults },
  })),
});

/**
 * Build a mock schema that always fails validation.
 * @returns {{ safeParse: Function }} Mock schema with a failing safeParse function.
 */
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

  test('should use Zod-transformed values for present keys on PUT', () => {
    const schema = {
      safeParse: jest.fn((body) => ({
        success: true,
        data: { name: body.name.trim(), extra: 'injected' },
      })),
    };
    req = { method: 'PUT', body: { name: '  hello  ' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'hello' });
    expect(req.body).not.toHaveProperty('extra');
  });

  test('should keep Zod defaults on POST create operations', () => {
    const schema = mockSchema({ roles: ['user'], emailVerified: false });
    req = { method: 'POST', body: { email: 'a@b.com', password: 'secret' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({
      email: 'a@b.com',
      password: 'secret',
      roles: ['user'],
      emailVerified: false,
    });
  });

  test('should filter out unknown keys not present in Zod output on PUT', () => {
    const schema = {
      safeParse: jest.fn(() => ({
        success: true,
        data: { name: 'valid' },
      })),
    };
    req = { method: 'PUT', body: { name: 'valid', unknownField: 'hack' } };

    model.isValid(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'valid' });
    expect(req.body).not.toHaveProperty('unknownField');
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
