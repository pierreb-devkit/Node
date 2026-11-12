/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, expect } from '@jest/globals';
import { PassThrough } from 'stream';

/**
 * Unit tests for lib/services/gridfs.js
 *
 * The bucket mock is shaped like the real MongoDB 7 driver: `delete(id, options)`
 * returns a promise and never calls a callback passed to it.
 */
describe('gridfs service unit tests:', () => {
  let gridfs;
  let mockBucket;
  let mockModel;

  beforeEach(async () => {
    jest.resetModules();

    mockBucket = {
      // Driver-shaped: ignores any extra argument, only settles its promise.
      delete: jest.fn(() => Promise.resolve()),
      openUploadStreamWithId: jest.fn((id) => Object.assign(new PassThrough(), { id })),
    };
    mockModel = { findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ _id: 'f1' }) })) };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        connection: { db: {} },
        mongo: { GridFSBucket: jest.fn(() => mockBucket) },
        Types: { ObjectId: jest.fn(() => 'new-id') },
        model: jest.fn(() => mockModel),
      },
    }));

    gridfs = (await import('../gridfs.js')).default;
  });

  describe('_removeFile', () => {
    test('calls back with no error once the driver delete resolves', async () => {
      const cb = jest.fn();
      gridfs.getStorage()._removeFile({}, { id: 'file-1' }, cb);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockBucket.delete).toHaveBeenCalledWith('file-1');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null);
    });

    test('calls back with the error when the driver delete rejects', async () => {
      const error = new Error('File not found for id file-1');
      mockBucket.delete.mockImplementationOnce(() => Promise.reject(error));
      const cb = jest.fn();
      gridfs.getStorage()._removeFile({}, { id: 'file-1' }, cb);
      await new Promise((resolve) => setImmediate(resolve));

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(error);
    });
  });

  describe('createFromBuffer', () => {
    test('stores the MIME type in metadata.contentType, not as a top-level option', async () => {
      const result = await gridfs.createFromBuffer(Buffer.from('x'), 'a.jpeg', 'image/jpeg', { kind: 'snapshot' });

      expect(result).toEqual({ _id: 'f1' });
      const [, filename, options] = mockBucket.openUploadStreamWithId.mock.calls[0];
      expect(filename).toBe('a.jpeg');
      expect(options).toEqual({ metadata: { kind: 'snapshot', contentType: 'image/jpeg' } });
    });
  });
});
