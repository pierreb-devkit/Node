/**
 * Module dependencies.
 */
import { STATUS_CODES } from 'node:http';
import { describe, test, expect } from '@jest/globals';
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
 * Unit tests — responses.error's title (`message`) param is optional (#4009).
 * Omitted, it must be derived from `node:http`'s STATUS_CODES for the
 * RESOLVED status, so a dynamic status and its title can never disagree. An
 * explicit title must keep winning unchanged, so the ~164 existing call
 * sites that hand-write a title stay untouched.
 */
describe('responses.error — title derivation from STATUS_CODES:', () => {
  test.each([400, 403, 404, 409, 422, 503])(
    'derives message from STATUS_CODES[%i] when title omitted, ignoring error.message',
    (status) => {
      const res = buildRes();
      // A real Error with its own .message: the derivation must win over it,
      // not just over an empty/absent error — this is what discriminates
      // "derive from status" from the old "fall back to error.message".
      responses.error(res, status)(new Error('internal detail, must not leak as title'));
      expect(res._body.message).toBe(STATUS_CODES[status]);
      expect(res._body.status).toBe(status);
    },
  );

  test('derives from the RESOLVED status when httpStatus is omitted and the error carries it', () => {
    const res = buildRes();
    responses.error(res, undefined)({ status: 409, message: 'internal detail' });
    expect(res._body.message).toBe('Conflict');
    expect(res._body.status).toBe(409);
  });

  test('explicit title wins and is passed through unchanged (backward compatible)', () => {
    const res = buildRes();
    responses.error(res, 409, 'Custom Title')(new Error('irrelevant'));
    expect(res._body.message).toBe('Custom Title');
  });

  test('falls back to the generic string for a status with no STATUS_CODES entry', () => {
    const res = buildRes();
    responses.error(res, 499)(new Error('irrelevant'));
    expect(res._body.message).toBe('Something went wrong.');
  });
});
