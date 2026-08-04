/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for uploads.repository.js — remove() no-op semantics and
 * sweepUnreferenced() multi-path unreferenced-blob sweep.
 */
describe('UploadRepository unit tests:', () => {
  let UploadRepository;
  let mockUploadsModel;
  let mockBucket;
  let mockDb;
  let mockLogger;

  /** Builds an async-iterable cursor stub from a plain array of docs. */
  const asCursor = (docs) => ({
    [Symbol.asyncIterator]: async function* iterate() {
      for (const doc of docs) yield doc;
    },
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBucket = { delete: jest.fn().mockResolvedValue(undefined), openDownloadStream: jest.fn() };

    mockLogger = { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    mockDb = {
      listCollections: jest.fn(() => ({ hasNext: jest.fn().mockResolvedValue(true) })),
      collection: jest.fn(() => ({ aggregate: jest.fn(() => asCursor([])) })),
    };

    mockUploadsModel = {
      findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(null) })),
      find: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() => asCursor([])),
      })),
      aggregate: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        model: jest.fn(() => mockUploadsModel),
        connection: { db: mockDb },
        mongo: { GridFSBucket: jest.fn(() => mockBucket) },
      },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));

    const mod = await import('../repositories/uploads.repository.js');
    UploadRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('remove', () => {
    test('is a no-op when no record matches the lookup (already removed)', async () => {
      mockUploadsModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      const result = await UploadRepository.remove({ filename: 'gone.png' });

      expect(result).toEqual({ deletedCount: 0, notFound: true });
      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Upload: remove - no matching file, treating as already removed',
        { filename: 'gone.png' },
      );
    });

    test('deletes the GridFS file when the doc already carries an _id', async () => {
      const upload = { _id: 'abc123', filename: 'present.png' };

      const result = await UploadRepository.remove(upload);

      expect(mockUploadsModel.findOne).not.toHaveBeenCalled();
      expect(mockBucket.delete).toHaveBeenCalledWith('abc123');
      expect(result).toBeUndefined();
    });

    test('throws on a genuine GridFS bucket failure for a file that DOES exist', async () => {
      const upload = { _id: 'abc123', filename: 'present.png' };
      mockBucket.delete.mockRejectedValueOnce(new Error('bucket unreachable'));

      await expect(UploadRepository.remove(upload)).rejects.toThrow('Upload: delete error');
      expect(mockBucket.delete).toHaveBeenCalledWith('abc123');
    });
  });

  describe('sweepUnreferenced', () => {
    const kind = 'htmlSnapshot';
    const collection = 'histories';

    test('throws when paths is missing/empty', async () => {
      await expect(UploadRepository.sweepUnreferenced(kind, collection, [], 1000)).rejects.toThrow(
        'sweepUnreferenced requires at least one reference path',
      );
    });

    test('throws when the target collection does not exist (fails loudly, not a silent empty result)', async () => {
      mockDb.listCollections.mockReturnValue({ hasNext: jest.fn().mockResolvedValue(false) });

      await expect(UploadRepository.sweepUnreferenced(kind, 'typo_collection', ['snapshot'], 1000)).rejects.toThrow(
        'target collection "typo_collection" does not exist',
      );
    });

    test('respects the grace window: an unreferenced-but-young blob is skipped, not deleted', async () => {
      const now = Date.now();
      mockUploadsModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() => asCursor([{ _id: 'young1', filename: 'young.png', uploadDate: new Date(now - 1000) }])),
      });

      const counters = await UploadRepository.sweepUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, orphaned: 1, deleted: 0, skippedTooYoung: 1 });
    });

    test('sweeps an unreferenced blob past the grace window on a scalar reference path', async () => {
      const now = Date.now();
      mockDb.collection.mockReturnValue({ aggregate: jest.fn(() => asCursor([])) }); // nothing references it
      mockUploadsModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() => asCursor([{ _id: 'old1', filename: 'orphan.png', uploadDate: new Date(now - 120_000) }])),
      });

      const counters = await UploadRepository.sweepUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).toHaveBeenCalledWith('old1');
      expect(counters).toMatchObject({ scanned: 1, orphaned: 1, deleted: 1, skippedTooYoung: 0 });
    });

    test('keeps a blob referenced via a scalar path', async () => {
      const now = Date.now();
      mockDb.collection.mockReturnValue({ aggregate: jest.fn(() => asCursor([{ refs: ['referenced.png'] }])) });
      mockUploadsModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() => asCursor([{ _id: 'ref1', filename: 'referenced.png', uploadDate: new Date(now - 120_000) }])),
      });

      const counters = await UploadRepository.sweepUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, referenced: 1, orphaned: 0, deleted: 0 });
    });

    test('keeps a blob referenced via an array-of-subdocuments path', async () => {
      const now = Date.now();
      // Simulates the aggregation already flattening an array-of-subdocuments
      // path (e.g. `snapshots.html`) into the referenced-filename set.
      mockDb.collection.mockReturnValue({
        aggregate: jest.fn(() => asCursor([{ refs: ['sub1.png', 'sub2.png'] }])),
      });
      mockUploadsModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() =>
          asCursor([
            { _id: 'sub1', filename: 'sub1.png', uploadDate: new Date(now - 120_000) },
            { _id: 'sub2', filename: 'sub2.png', uploadDate: new Date(now - 120_000) },
          ]),
        ),
      });

      const counters = await UploadRepository.sweepUnreferenced(kind, collection, ['snapshots.html'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 2, referenced: 2, orphaned: 0, deleted: 0 });
    });

    test('keeps a blob referenced by only ONE of several paths (data-loss guard)', async () => {
      const now = Date.now();
      // Only the second path (`snapshots.html`) references it — a
      // single-path check would have missed this and deleted a live blob.
      mockDb.collection.mockReturnValue({
        aggregate: jest.fn(() => asCursor([{ refs: ['multi-ref.png'] }])),
      });
      mockUploadsModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        cursor: jest.fn(() => asCursor([{ _id: 'multi1', filename: 'multi-ref.png', uploadDate: new Date(now - 120_000) }])),
      });

      const counters = await UploadRepository.sweepUnreferenced(kind, collection, ['avatar', 'snapshots.html'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, referenced: 1, orphaned: 0, deleted: 0 });
    });
  });
});
