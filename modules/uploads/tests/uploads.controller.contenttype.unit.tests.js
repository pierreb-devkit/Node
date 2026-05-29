/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { Readable } from 'stream';

/**
 * Unit tests for uploads controller Content-Type allowlist (defense-in-depth against stored-XSS).
 */
describe('Uploads controller content-type allowlist unit tests:', () => {
  let UploadsController;
  let mockUploadsService;

  /**
   * Returns a minimal readable stream for mocking getStream.
   * stream.pipe returns `dest` to satisfy chained pipe calls
   * (stream.pipe(transform).pipe(res)) without throwing.
   */
  const makeStream = () => {
    const s = new Readable({ read() {} });
    s.push(null);
    s.pipe = jest.fn((dest) => dest);
    return s;
  };

  /**
   * Returns a mock res object tracking set() calls.
   */
  const makeRes = () => {
    const headers = {};
    return {
      set: jest.fn((key, value) => { headers[key] = value; }),
      _headers: headers,
      pipe: jest.fn(),
    };
  };

  beforeEach(async () => {
    jest.resetModules();

    mockUploadsService = {
      getStream: jest.fn(),
      get: jest.fn(),
      remove: jest.fn(),
    };

    jest.unstable_mockModule('../services/uploads.service.js', () => ({
      default: mockUploadsService,
    }));

    // Minimal config mock — sharp config is read inside getSharp only for operations
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { uploads: { sharp: { blur: 3 } } },
    }));

    // sharp is a real dependency; mock it to avoid needing native bindings in unit context.
    // pipe must return `dest` (matching the real Stream.pipe contract) so that chained
    // calls stream.pipe(transform).pipe(res) work without throwing.
    jest.unstable_mockModule('sharp', () => ({
      default: jest.fn(() => ({
        resize: jest.fn().mockReturnThis(),
        blur: jest.fn().mockReturnThis(),
        grayscale: jest.fn().mockReturnThis(),
        pipe: jest.fn((dest) => dest),
      })),
    }));

    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn((e) => e.message) },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        error: jest.fn(() => jest.fn()),
        success: jest.fn(() => jest.fn()),
      },
    }));

    const mod = await import('../controllers/uploads.controller.js');
    UploadsController = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── get (private download path) ───────────────────────────────────────────

  describe('get — Content-Type allowlist', () => {
    test('should pass through a safe MIME type (image/jpeg)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'image/jpeg', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
      expect(res.set).toHaveBeenCalledWith('Content-Disposition', 'attachment');
    });

    test('should pass through image/png', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'image/png', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/png');
    });

    test('should pass through application/pdf', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'application/pdf', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    });

    test('should downgrade dangerous MIME text/html to application/octet-stream', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'text/html', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    test('should downgrade image/svg+xml to application/octet-stream', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'image/svg+xml', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    test('should downgrade text/javascript to application/octet-stream', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'text/javascript', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    test('should normalize uppercase MIME to lowercase and pass through (Image/JPEG → image/jpeg)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'Image/JPEG', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should strip MIME parameters before allowlist check (image/jpeg; charset=binary → image/jpeg)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'image/jpeg; charset=binary', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should fall back to application/octet-stream when contentType is missing', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    test('should use metadata.contentType as fallback when contentType is absent', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', metadata: { contentType: 'image/webp' }, length: 50 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/webp');
    });

    test('should downgrade dangerous metadata.contentType to application/octet-stream', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', metadata: { contentType: 'text/html' }, length: 50 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    test('should set Content-Disposition: attachment on every private download', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.get(
        { upload: { _id: '1', contentType: 'image/jpeg', length: 100 } },
        res,
      );

      expect(res.set).toHaveBeenCalledWith('Content-Disposition', 'attachment');
    });
  });

  // ── getSharp (public image path) ──────────────────────────────────────────

  describe('getSharp — Content-Type allowlist (image-only)', () => {
    const makeImageReq = (contentType) => ({
      upload: { _id: '1', contentType, length: 200 },
      sharpSize: 512,
      sharpOption: null,
    });

    const makeImageReqMeta = (metaContentType) => ({
      upload: { _id: '1', metadata: { contentType: metaContentType }, length: 200 },
      sharpSize: 512,
      sharpOption: null,
    });

    test('should pass through image/jpeg on public path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('image/jpeg'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should downgrade text/html to image/jpeg on public image path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('text/html'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should downgrade image/svg+xml to image/jpeg on public image path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('image/svg+xml'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should downgrade application/pdf to image/jpeg on public image path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('application/pdf'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should pass through image/webp on public image path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('image/webp'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/webp');
    });

    test('should normalize uppercase MIME and pass through (IMAGE/PNG → image/png)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('IMAGE/PNG'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/png');
    });

    test('should strip MIME parameters before allowlist check (image/jpeg; charset=binary → image/jpeg)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReq('image/jpeg; charset=binary'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should use metadata.contentType as fallback when contentType is absent (safe value)', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReqMeta('image/png'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/png');
    });

    test('should downgrade dangerous metadata.contentType to image/jpeg on public path', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp(makeImageReqMeta('text/html'), res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });

    test('should fall back to image/jpeg when both contentType and metadata.contentType are absent', async () => {
      const stream = makeStream();
      mockUploadsService.getStream.mockResolvedValue(stream);
      const res = makeRes();

      await UploadsController.getSharp({ upload: { _id: '1', length: 200 }, sharpSize: 512, sharpOption: null }, res);

      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
    });
  });
});
