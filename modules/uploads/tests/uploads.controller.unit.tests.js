/**
 * Unit tests for the uploads controller.
 *
 * Stream error handlers in `get()` and `getSharp()` must guard against
 * `ERR_HTTP_HEADERS_SENT` when a GridFS stream fails mid-transfer after
 * response headers have already been flushed to the client.
 */
import { jest, afterAll, beforeAll } from '@jest/globals';
import path from 'path';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import logger from '../../../lib/services/logger.js';

describe('Uploads controller unit tests:', () => {
  let UploadsController;
  let UploadsService;

  beforeAll(async () => {
    await bootstrap();
    UploadsController = (await import(path.resolve('./modules/uploads/controllers/uploads.controller.js'))).default;
    UploadsService = (await import(path.resolve('./modules/uploads/services/uploads.service.js'))).default;
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
    jest.spyOn(UploadsService, 'getStream').mockResolvedValueOnce(stream);
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
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
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
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('uploads.get'), err);
      loggerSpy.mockRestore();
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
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const { listeners } = installStream();
      const res = buildRes();

      await UploadsController.getSharp(req, res);

      res.headersSent = true;
      const err = new Error('sharp pipeline mid-stream abort');
      listeners.error(err);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalledWith(err);
      // Error must reach the logger so mid-stream GridFS failures are visible.
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('uploads.getSharp'), err);
      loggerSpy.mockRestore();
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

  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (err) {
      // Best-effort cleanup; ignore connection teardown noise.
      console.log(err);
    }
  });
});
