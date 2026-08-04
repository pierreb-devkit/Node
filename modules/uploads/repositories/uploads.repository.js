/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import AppError from '../../../lib/helpers/AppError.js';
import logger from '../../../lib/services/logger.js';

const Uploads = mongoose.model('Uploads');

const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
  bucketName: 'uploads',
});

/**
 * @desc Function to get all upload in db with filter or not
 * @param {Object} Filter
 * @return {Array} uploads
 */
const list = (filter) => Uploads.find(filter).select('filename uploadDate contentType').sort('-createdAt').exec();

/**
 * @desc Function to get an upload from db
 * @param {String} uploadName
 * @return {Stream} upload
 */
const get = (uploadName) => Uploads.findOne({ filename: uploadName }).exec();

/**
 * @desc Function to get an upload stream from db
 * @param {Object} Upload
 * @return {Stream} upload
 */
const getStream = (upload) => {
  try {
    return bucket.openDownloadStream(upload._id);
  } catch (err) {
    throw new AppError('Uppload: read error', { code: 'REPOSITORY_ERROR', details: err });
  }
};

/**
 * @desc Function to update an upload in db
 * @param {ObjectID} upload ID
 * @param {Object} update
 * @return {Object} upload updated
 */
const update = (id, update) => Uploads.findOneAndUpdate({ _id: id }, update, { returnDocument: 'after' }).exec();

/**
 * @desc Function to remove an upload from db. A missing file — no record
 * matches the lookup, e.g. a filename already deleted by a previous pass —
 * is a NO-OP (logged at debug), not a thrown error. A retention job that
 * re-runs over the same window can call this with the SAME filename across
 * passes when a persist fails after a successful delete; treating "already
 * gone" as success (instead of throwing) prevents that resurfacing as
 * per-pass error-log noise. A genuine GridFS failure (bucket error deleting
 * a file that DOES exist) still throws — only the "nothing to delete" case
 * is swallowed.
 * @param {Object} upload - an Upload doc (with `_id`), or a bare lookup key
 *   (e.g. `{ filename }`)
 * @return {Object} confirmation of delete, or a no-op marker when no
 *   matching file was found
 */
const remove = async (upload) => {
  const filename = upload?.filename;
  if (!upload || !upload._id) upload = await Uploads.findOne({ filename }).exec();
  if (!upload) {
    logger.debug('Upload: remove - no matching file, treating as already removed', { filename });
    return { deletedCount: 0, notFound: true };
  }
  try {
    const unlinked = await bucket.delete(upload._id);
    return unlinked;
  } catch (err) {
    throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: err });
  }
};

/**
 * @desc Function to remove uploads of one user in db
 * @param {Object} filter
 * @return {Object} confirmation of delete
 */
const deleteMany = async (filter) => {
  const uploads = await list(filter);
  let deletedCount = 0;
   
  for (const upload of uploads) {
    try {
       
      await bucket.delete(upload._id);
      deletedCount += 1;
    } catch (err) {
      throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: err });
    }
  }
  return { deletedCount };
};

/**
 * @desc Function to purge uploads by kind if they are not referenced in another collection
 * @param {String} kind - metadata kind to match
 * @param {collection} collection - name of the collection to check reference presence
 * @param {String} key - name of the key to check id
 * @return {Object} confirmation of delete
 */
const purge = async (kind, collection, key) => {
  const toDelete = await Uploads.aggregate([
    { $match: { 'metadata.kind': kind } },
    {
      $lookup: {
        from: collection,
        localField: 'filename',
        foreignField: key,
        as: 'references',
      },
    },
    { $match: { references: [] } },
  ]);
  let deletedCount = 0;
   
  for (const upload of toDelete) {
    try {
       
      await bucket.delete(upload._id);
      deletedCount += 1;
    } catch (err) {
      throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: err });
    }
  }
  return { deletedCount };
};

/**
 * @desc Sweep GridFS blobs of a given `kind` that are unreferenced by ANY of
 * several possible reference paths on another collection, respecting a
 * minimum age (grace window) so a blob written moments ago — before the
 * document that will reference it is persisted — is never swept.
 *
 * Kept as a separate function rather than a `purge()` extension — not merely
 * to avoid touching `purge()`'s existing callers, but because the two use
 * genuinely different, non-interchangeable query strategies: `purge()`'s
 * native `$lookup` localField/foreignField join lets MongoDB use an index on
 * the foreign collection for an equality match — appropriate when there's
 * exactly one reference key. That strategy has no way to express "referenced
 * by path A OR path B OR ..." (a blob referenced only via a path it doesn't
 * check would look unreferenced and be deleted — data loss, worse than the
 * leak this fixes), which is why this function instead does a full streaming
 * scan (see Implementation below) — the only way to check several paths,
 * some of them arrays, without N correlated sub-queries. Forcing `purge()`'s
 * single-key callers through that broader scan would trade an indexed join
 * for a full collection scan for no benefit; forcing this function's
 * multi-path callers through a `$lookup` would reintroduce the N-sub-queries
 * problem. One function selecting between two internal algorithms by
 * argument shape would not actually be simpler than two named functions.
 * `purge()` also has no age floor, and bolting one on would change behaviour
 * for its existing caller. A reference path may point at a scalar field or
 * an array-of-subdocuments field (e.g. `snapshots.html` where `snapshots` is
 * an array) — both are normalised to an array before the OR check.
 *
 * Implementation: rather than a correlated `$lookup` pipeline per candidate
 * upload (a nested-loop join — one sub-query per row against `collection`),
 * this makes ONE streaming pass over `collection` to build an in-memory Set
 * of every filename referenced from any `paths` entry, then a single
 * streaming pass over the candidate uploads checking Set membership:
 * O(collection) + O(uploads) instead of O(uploads × collection). The
 * collection-side pass never accumulates into a single Mongo document
 * (would risk the 16MB BSON limit at scale) — dedup happens client-side.
 *
 * Fails loudly (throws) if `collection` does not exist, rather than treating
 * a mistyped name as "nothing is referenced" — the latter would silently
 * delete every candidate blob once past the grace window: a wrong
 * collection name must never look like a clean, empty result.
 *
 * @param {String} kind - metadata.kind to sweep (e.g. 'htmlSnapshot')
 * @param {String} collection - name of the collection to check references against
 * @param {String[]} paths - dot-paths on `collection` docs that may reference an upload's filename
 * @param {Number} minAgeMs - minimum age (ms, from GridFS `uploadDate`) before an unreferenced blob is eligible for deletion
 * @return {Object} counters — { scanned, referenced, orphaned, deleted, skippedTooYoung }
 */
const sweepUnreferenced = async (kind, collection, paths, minAgeMs) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AppError('Upload: sweepUnreferenced requires at least one reference path', { code: 'REPOSITORY_ERROR' });
  }
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new AppError('Upload: sweepUnreferenced requires a non-negative minAgeMs', { code: 'REPOSITORY_ERROR' });
  }

  /* A mistyped `collection` name would make the aggregation below return an
   * EMPTY cursor — every candidate would then look unreferenced and get
   * deleted once past the grace window. That failure mode is silent DATA
   * LOSS. Fail loudly instead. */
  const collectionExists = await mongoose.connection.db
    .listCollections({ name: collection }, { nameOnly: true })
    .hasNext();
  if (!collectionExists) {
    throw new AppError(`Upload: sweepUnreferenced target collection "${collection}" does not exist`, { code: 'REPOSITORY_ERROR' });
  }

  // Normalises a reference path's value to an array: missing/null -> [],
  // an array field (e.g. across subdocuments) -> itself, a scalar -> [value].
  const toArrayExpr = (path) => {
    const field = `$${path}`;
    return {
      $let: {
        vars: { v: { $ifNull: [field, null] } },
        in: {
          $cond: [{ $eq: ['$$v', null] }, [], { $cond: [{ $isArray: '$$v' }, '$$v', ['$$v']] }],
        },
      },
    };
  };

  const referenced = new Set();
  const referenceCursor = mongoose.connection.db.collection(collection).aggregate([
    { $project: { _id: 0, refs: { $concatArrays: paths.map(toArrayExpr) } } },
    { $match: { 'refs.0': { $exists: true } } },
  ]);
  for await (const doc of referenceCursor) {
    for (const filename of doc.refs) {
      if (typeof filename === 'string') referenced.add(filename);
    }
  }

  const now = Date.now();
  let scanned = 0;
  let referencedCount = 0;
  let orphaned = 0;
  let deleted = 0;
  let skippedTooYoung = 0;

  const candidateCursor = Uploads.find({ 'metadata.kind': kind }).select('filename uploadDate').lean().cursor();
  for await (const candidate of candidateCursor) {
    scanned += 1;
    if (referenced.has(candidate.filename)) {
      referencedCount += 1;
      continue;
    }
    orphaned += 1;
    // Missing uploadDate is treated as "unknown age" -> never eligible for
    // deletion (fail closed, not open) rather than as "very old".
    const ageMs = candidate.uploadDate ? now - new Date(candidate.uploadDate).getTime() : -1;
    if (ageMs < minAgeMs) {
      skippedTooYoung += 1;
      continue;
    }
    try {
      await bucket.delete(candidate._id);
      deleted += 1;
    } catch (err) {
      logger.error('Upload: sweepUnreferenced - delete failed', {
        filename: candidate.filename,
        kind,
        error: err?.message,
      });
    }
  }

  const counters = { scanned, referenced: referencedCount, orphaned, deleted, skippedTooYoung };
  logger.info('Upload: sweepUnreferenced complete', { kind, collection, minAgeMs, ...counters });
  return counters;
};

export default {
  list,
  get,
  getStream,
  update,
  remove,
  deleteMany,
  purge,
  sweepUnreferenced,
};
