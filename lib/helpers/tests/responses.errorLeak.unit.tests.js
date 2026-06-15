/**
 * Module dependencies.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import responses from '../responses.js';

/**
 * Build a minimal Express response double that captures status + json body.
 * @returns {{status: Function, json: Function, _status: number, _body: object}}
 */
const buildRes = () => {
  const res = {
    _status: undefined,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
};

/**
 * Unit tests — responses.error must NOT serialize the raw error object into the
 * client payload outside of dev/test/local. The deployment model runs apps under
 * arbitrary NODE_ENV labels, so the leak gate keys off the dev-env predicate, not
 * the literal `production`.
 */
describe('responses.error — error-object leak gating:', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('does NOT include serialized error in body under a project (non-dev) env', () => {
    process.env.NODE_ENV = 'someproject';
    const res = buildRes();
    responses.error(res, 500, undefined, undefined)(new Error('secret internal detail'));
    expect(res._body).toBeDefined();
    expect(res._body.error).toBeUndefined();
    // The generic envelope fields stay present.
    expect(res._body.type).toBe('error');
    expect(res._body.status).toBe(500);
  });

  test('does NOT include serialized error in body under production', () => {
    process.env.NODE_ENV = 'production';
    const res = buildRes();
    responses.error(res, 500)(new Error('secret internal detail'));
    expect(res._body.error).toBeUndefined();
  });

  test('DOES include serialized error in body under development (debugging aid)', () => {
    process.env.NODE_ENV = 'development';
    const res = buildRes();
    responses.error(res, 500)(new Error('debuggable detail'));
    expect(typeof res._body.error).toBe('string');
  });

  test('DOES include serialized error in body under test', () => {
    process.env.NODE_ENV = 'test';
    const res = buildRes();
    responses.error(res, 500)(new Error('debuggable detail'));
    expect(typeof res._body.error).toBe('string');
  });
});
