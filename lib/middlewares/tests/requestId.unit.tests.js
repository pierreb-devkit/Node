/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import requestId from '../requestId.js';

describe('requestId middleware unit tests:', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      _headers: {},
      setHeader(key, value) {
        this._headers[key] = value;
      },
    };
    next = jest.fn();
  });

  test('should generate a UUID when no X-Request-ID header is present', () => {
    requestId(req, res, next);

    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
    // UUID v4 format
    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res._headers['X-Request-ID']).toBe(req.id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should reuse X-Request-ID from incoming request header', () => {
    req.headers['x-request-id'] = 'custom-id-123';

    requestId(req, res, next);

    expect(req.id).toBe('custom-id-123');
    expect(res._headers['X-Request-ID']).toBe('custom-id-123');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should call next exactly once', () => {
    requestId(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
