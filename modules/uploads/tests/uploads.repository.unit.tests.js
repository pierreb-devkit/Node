/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for uploads.repository.js — remove() no-op semantics and
 * purgeUnreferenced() multi-path unreferenced-blob sweep.
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

  /** Stubs Uploads.find(...).select().lean().cursor() to yield `docs`. */
  const setCandidates = (docs) => {
    mockUploadsModel.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      cursor: jest.fn(() => asCursor(docs)),
    });
  };

  /** Stubs db.collection(...).aggregate(...) to yield `docs` (reference scan). */
  const setReferences = (docs) => {
    mockDb.collection.mockReturnValue({ aggregate: jest.fn(() => asCursor(docs)) });
  };

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
      // No `aggregate` mock here — this file only exercises remove() and
      // purgeUnreferenced(); the latter uses the raw driver's
      // db.collection().aggregate(), not Uploads.aggregate() (that's
      // purge()'s path, untested in this file).
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
        { filename: 'gone.png', lookup: { filename: 'gone.png' } },
      );
    });

    test.each([[null], [undefined], [{}]])(
      'short-circuits to the no-op WITHOUT querying when called with %p (a lookup key with neither _id nor a string filename can never resolve)',
      async (arg) => {
        const result = await UploadRepository.remove(arg);

        expect(mockUploadsModel.findOne).not.toHaveBeenCalled();
        expect(result).toEqual({ deletedCount: 0, notFound: true });
        expect(mockBucket.delete).not.toHaveBeenCalled();
      },
    );

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

  describe('purgeUnreferenced', () => {
    const kind = 'htmlSnapshot';
    const collection = 'histories';

    test.each([[undefined], [null], ['']])('throws for a missing/empty kind (%p) instead of silently matching every kind', async (badKind) => {
      await expect(UploadRepository.purgeUnreferenced(badKind, collection, ['snapshot'], 1000)).rejects.toThrow(
        'purgeUnreferenced requires a non-empty kind',
      );
      expect(mockBucket.delete).not.toHaveBeenCalled();
    });

    test('throws when paths is missing/empty', async () => {
      await expect(UploadRepository.purgeUnreferenced(kind, collection, [], 1000)).rejects.toThrow(
        'purgeUnreferenced requires at least one reference path',
      );
    });

    test('throws when the target collection does not exist (fails loudly, not a silent empty result)', async () => {
      mockDb.listCollections.mockReturnValue({ hasNext: jest.fn().mockResolvedValue(false) });

      await expect(UploadRepository.purgeUnreferenced(kind, 'typo_collection', ['snapshot'], 1000)).rejects.toThrow(
        'target collection "typo_collection" does not exist',
      );
    });

    test.each([[-1], [NaN], [Infinity]])('throws for an invalid graceMs (%p)', async (graceMs) => {
      await expect(UploadRepository.purgeUnreferenced(kind, collection, ['snapshot'], graceMs)).rejects.toThrow(
        'purgeUnreferenced requires a non-negative graceMs',
      );
      expect(mockBucket.delete).not.toHaveBeenCalled();
    });

    test('a partial sweep (one delete fails) is visible in the counters, not silently reported as a clean sweep', async () => {
      const now = Date.now();
      setReferences([]);
      setCandidates([{ _id: 'flaky1', filename: 'flaky.png', uploadDate: new Date(now - 120_000) }]);
      mockBucket.delete.mockRejectedValueOnce(new Error('bucket unreachable'));

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(counters).toMatchObject({ scanned: 1, orphaned: 1, deleted: 0, deleteFailed: 1 });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Upload: purgeUnreferenced - delete failed',
        expect.objectContaining({ filename: 'flaky.png', kind }),
      );
    });

    test('respects the grace window: an unreferenced-but-young blob is skipped, not deleted', async () => {
      const now = Date.now();
      setCandidates([{ _id: 'young1', filename: 'young.png', uploadDate: new Date(now - 1000) }]);

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, orphaned: 1, deleted: 0, skippedTooYoung: 1 });
    });

    test('sweeps an unreferenced blob past the grace window on a scalar reference path', async () => {
      const now = Date.now();
      setReferences([]); // nothing references it
      setCandidates([{ _id: 'old1', filename: 'orphan.png', uploadDate: new Date(now - 120_000) }]);

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).toHaveBeenCalledWith('old1');
      expect(counters).toMatchObject({ scanned: 1, orphaned: 1, deleted: 1, skippedTooYoung: 0 });
    });

    test('keeps a blob referenced via a scalar path', async () => {
      const now = Date.now();
      setReferences([{ refs: ['referenced.png'] }]);
      setCandidates([{ _id: 'ref1', filename: 'referenced.png', uploadDate: new Date(now - 120_000) }]);

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['snapshot'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, referenced: 1, orphaned: 0, deleted: 0 });
    });

    test('keeps a blob referenced via an array-of-subdocuments path', async () => {
      const now = Date.now();
      // Simulates the aggregation already flattening an array-of-subdocuments
      // path (e.g. `snapshots.html`) into the referenced-filename set.
      setReferences([{ refs: ['sub1.png', 'sub2.png'] }]);
      setCandidates([
        { _id: 'sub1', filename: 'sub1.png', uploadDate: new Date(now - 120_000) },
        { _id: 'sub2', filename: 'sub2.png', uploadDate: new Date(now - 120_000) },
      ]);

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['snapshots.html'], 60_000);

      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 2, referenced: 2, orphaned: 0, deleted: 0 });
    });

    test('keeps a blob referenced by only ONE of several paths (data-loss guard)', async () => {
      const now = Date.now();
      // Only the second path (`snapshots.html`) references it — a
      // single-path check would have missed this and deleted a live blob.
      // Capture the aggregate call directly (instead of setReferences(),
      // which ignores its pipeline argument) so this test can also assert
      // BOTH paths actually reached the pipeline — otherwise a regression
      // that built the pipeline from only the first path would still pass.
      const aggregate = jest.fn(() => asCursor([{ refs: ['multi-ref.png'] }]));
      mockDb.collection.mockReturnValue({ aggregate });
      setCandidates([{ _id: 'multi1', filename: 'multi-ref.png', uploadDate: new Date(now - 120_000) }]);

      const counters = await UploadRepository.purgeUnreferenced(kind, collection, ['avatar', 'snapshots.html'], 60_000);

      const pipeline = JSON.stringify(aggregate.mock.calls[0][0]);
      expect(pipeline).toContain('$avatar');
      expect(pipeline).toContain('$snapshots.html');
      expect(mockBucket.delete).not.toHaveBeenCalled();
      expect(counters).toMatchObject({ scanned: 1, referenced: 1, orphaned: 0, deleted: 0 });
    });
  });
});
