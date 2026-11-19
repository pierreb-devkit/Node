/**
 * Module dependencies.
 */
import { jest, describe, it, expect } from '@jest/globals';

import multerService from '../middlewares/uploads.multer.js';

/**
 * Unit tests for the upload middleware file filter.
 */
describe('Uploads multer unit tests:', () => {
  describe('Multer fileFilter', () => {
    it('should reject files exceeding size limit with SERVICE_ERROR code', () => {
      const filter = multerService.fileFilter(['image/png'], 1024);
      const req = { headers: { 'content-length': '2048' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
      const err = cb.mock.calls[0][0];
      expect(err.code).toBe('SERVICE_ERROR');
    });

    it('should reject files with unsupported mimetype with SERVICE_ERROR code', () => {
      const filter = multerService.fileFilter(['image/png'], 10240);
      const req = { headers: { 'content-length': '512' } };
      const file = { mimetype: 'application/pdf' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
      const err = cb.mock.calls[0][0];
      expect(err.code).toBe('SERVICE_ERROR');
    });

    it('should accept files within size limit and matching mimetype', () => {
      const filter = multerService.fileFilter(['image/png'], 10240);
      const req = { headers: { 'content-length': '512' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('should not call cb multiple times when file is too large', () => {
      const filter = multerService.fileFilter(['image/png'], 1024);
      const req = { headers: { 'content-length': '2048' } };
      const file = { mimetype: 'image/png' };
      const cb = jest.fn();
      filter(req, file, cb);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});
