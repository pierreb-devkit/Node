/**
 * Unit tests for the uploads controller.
 *
 * Stream error handlers in `get()` and `getSharp()` must guard against
 * `ERR_HTTP_HEADERS_SENT` when a GridFS stream fails mid-transfer after
 * response headers have already been flushed to the client.
 *
 * True unit test: UploadsService is mocked at the module boundary (its real
 * implementation reaches a GridFS bucket + a `mongoose.model('Uploads')` call
 * at import time, both of which require a live DB connection) so the suite
 * never needs `bootstrap()`.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

describe('Uploads controller unit tests:', () => {
  let UploadsController;
  let mockUploadsService;
  let mockLogger;

  beforeEach(async () => {
    jest.resetModules();

    mockUploadsService = {
      getStream: jest.fn(),
      get: jest.fn(),
      remove: jest.fn(),
    };

    mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

    jest.unstable_mockModule('../services/uploads.service.js', () => ({
      default: mockUploadsService,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    const mod = await import('../controllers/uploads.controller.js');
    UploadsController = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const buildRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.set = jest.fn();
    res.destroy = jest.fn();
    res.headersSent = false;
    return res;
  };

  /**
   * Install a fake stream that captures the `error` listener so tests can
   * invoke it manually — simulating either a pre-flush or mid-flush GridFS
   * failure depending on `res.headersSent`.
   */
  const installStream = () => {
    const listeners = {};
    const stream = {
      pipe: jest.fn().mockReturnThis(),
      on: jest.fn((event, handler) => {
        listeners[event] = handler;
        return stream;
      }),
    };
    mockUploadsService.getStream.mockResolvedValueOnce(stream);
    return { stream, listeners };
  };

  // ---------------------------------------------------------------------
  // get(): headersSent guard on stream error
  // ---------------------------------------------------------------------
  describe('get() headersSent guard on stream error', () => {
    const req = {
      upload: {
        _id: 'u1',
        contentType: 'image/jpeg',
        length: 1234,
        metadata: { contentType: 'image/jpeg' },
      },
    };

    test('responds 422 when stream errors BEFORE headers are sent', async () => {
      const { listeners } = installStream();
      const res = buildRes();

      await UploadsController.get(req, res);

      res.headersSent = false;
      const err = new Error('gridfs chunk missing');
      listeners.error(err);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.destroy).not.toHaveBeenCalled();
    });

    test('calls res.destroy(err) when stream errors AFTER headers are sent', async () => {
      const { listeners } = installStream();
      const res = buildRes();

      await UploadsController.get(req, res);

      // Simulate Node having already flushed the response head.
      res.headersSent = true;
      const err = new Error('gridfs mid-stream abort');
      listeners.error(err);

      // Must NOT attempt a new status + JSON body on a flushed response.
      expect(res.status).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalledWith(err);
      // Error must reach the logger so mid-stream GridFS failures are visible.
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('uploads.get'), err);
    });
  });

  // ---------------------------------------------------------------------
  // getSharp(): same guard on the sharp pipeline source stream
  // ---------------------------------------------------------------------
  describe('getSharp() headersSent guard on stream error', () => {
    const req = {
      upload: {
        _id: 'u1',
        contentType: 'image/jpeg',
        metadata: { contentType: 'image/jpeg' },
      },
      sharpSize: null,
      sharpOption: null,
    };

    test('responds 422 when stream errors BEFORE headers are sent', async () => {
      const { listeners } = installStream();
      const res = buildRes();

      // Awaiting getSharp reaches the default switch branch which pipes
      // through sharp(). We don't care about the resulting pipeline — we
      // only exercise the error listener captured above.
      await UploadsController.getSharp(req, res);

      res.headersSent = false;
      listeners.error(new Error('early gridfs failure'));

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.destroy).not.toHaveBeenCalled();
    });

    test('calls res.destroy(err) when stream errors AFTER headers are sent', async () => {
      const { listeners } = installStream();
      const res = buildRes();

      await UploadsController.getSharp(req, res);

      res.headersSent = true;
      const err = new Error('sharp pipeline mid-stream abort');
      listeners.error(err);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalledWith(err);
      // Error must reach the logger so mid-stream GridFS failures are visible.
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('uploads.getSharp'), err);
    });
  });

  // ---------------------------------------------------------------------
  // Content-Type allowlist — stored-XSS defense (devkit #3732)
  // ---------------------------------------------------------------------
  describe('Content-Type allowlist', () => {
    const buildReq = (contentType) => ({
      upload: { _id: 'u1', contentType, length: 100, metadata: { contentType } },
    });

    test('get() serves dangerous type as application/octet-stream', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.get(buildReq('text/html'), res);
      listeners.error(new Error('force close'));
      const setCall = res.set.mock.calls.find(([h]) => h === 'Content-Type');
      expect(setCall[1]).toBe('application/octet-stream');
      const dispCall = res.set.mock.calls.find(([h]) => h === 'Content-Disposition');
      expect(dispCall[1]).toBe('attachment');
    });

    test('get() passes through a safe image type unchanged', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.get(buildReq('image/png'), res);
      listeners.error(new Error('force close'));
      const setCall = res.set.mock.calls.find(([h]) => h === 'Content-Type');
      expect(setCall[1]).toBe('image/png');
    });

    test('get() normalises uppercase + charset param', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.get(buildReq('IMAGE/JPEG; charset=utf-8'), res);
      listeners.error(new Error('force close'));
      const setCall = res.set.mock.calls.find(([h]) => h === 'Content-Type');
      expect(setCall[1]).toBe('image/jpeg');
    });

    test('getSharp() serves dangerous type as image/jpeg', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.getSharp({ ...buildReq('text/html'), sharpSize: null, sharpOption: null }, res);
      listeners.error(new Error('force close'));
      const setCall = res.set.mock.calls.find(([h]) => h === 'Content-Type');
      expect(setCall[1]).toBe('image/jpeg');
    });

    test('getSharp() passes through a safe image type unchanged', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.getSharp({ ...buildReq('image/webp'), sharpSize: null, sharpOption: null }, res);
      listeners.error(new Error('force close'));
      const setCall = res.set.mock.calls.find(([h]) => h === 'Content-Type');
      expect(setCall[1]).toBe('image/webp');
    });

    test('getSharp() does NOT set Content-Disposition (must stay inline for img tags)', async () => {
      const { listeners } = installStream();
      const res = buildRes();
      await UploadsController.getSharp({ ...buildReq('image/jpeg'), sharpSize: null, sharpOption: null }, res);
      listeners.error(new Error('force close'));
      const dispCall = res.set.mock.calls.find(([h]) => h === 'Content-Disposition');
      expect(dispCall).toBeUndefined();
    });
  });
});
