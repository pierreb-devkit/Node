import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

describe('PostHogErrorTransport:', () => {
  let PostHogErrorTransport;
  let captureExceptionMock;

  beforeEach(async () => {
    jest.resetModules();
    captureExceptionMock = jest.fn();
    jest.unstable_mockModule('../errorTracker.js', () => ({
      default: { captureException: captureExceptionMock },
    }));
    const mod = await import('../logger.posthog.transport.js');
    PostHogErrorTransport = mod.PostHogErrorTransport;
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('only listens at error level by default', () => {
    const t = new PostHogErrorTransport();
    expect(t.level).toBe('error');
  });

  test('forwards info-as-Error to errorTracker.captureException', () => {
    const t = new PostHogErrorTransport();
    const err = new Error('boom');
    const cb = jest.fn();
    t.log(err, cb);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, expect.objectContaining({
      properties: expect.objectContaining({ source: 'system', logLevel: undefined }),
    }));
    expect(cb).toHaveBeenCalled();
  });

  test('extracts info.error when info is a plain object', () => {
    const t = new PostHogErrorTransport();
    const err = new Error('boom');
    const info = { level: 'error', message: 'something failed', error: err, requestId: 'r1' };
    const cb = jest.fn();
    t.log(info, cb);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, expect.objectContaining({
      requestId: 'r1',
      properties: expect.objectContaining({
        source: 'system',
        logMessage: 'something failed',
        logLevel: 'error',
      }),
    }));
  });

  test('wraps string-only info into a synthetic Error', () => {
    const t = new PostHogErrorTransport();
    const info = { level: 'error', message: 'no error object here' };
    const cb = jest.fn();
    t.log(info, cb);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('no error object here');
  });

  test('skips when err.posthogCaptured is true (dedup with express middleware)', () => {
    const t = new PostHogErrorTransport();
    const err = Object.assign(new Error('boom'), { posthogCaptured: true });
    const cb = jest.fn();
    t.log(err, cb);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalled();
  });

  test('sets posthogCaptured = true on the source Error after forwarding', () => {
    const t = new PostHogErrorTransport();
    const err = new Error('boom');
    const cb = jest.fn();
    t.log(err, cb);
    expect(err.posthogCaptured).toBe(true);
  });

  test('callback is always invoked even on captureException throw', () => {
    captureExceptionMock.mockImplementation(() => { throw new Error('SDK down'); });
    const t = new PostHogErrorTransport();
    const err = new Error('boom');
    const cb = jest.fn();
    expect(() => t.log(err, cb)).not.toThrow();
    expect(cb).toHaveBeenCalled();
  });
});
