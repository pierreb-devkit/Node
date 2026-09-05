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
    // Curated, not forwarded wholesale (issue #4059): only `message` — a short,
    // human-readable reason — crosses into `details`. The raw GridFS/driver
    // error may carry stack traces or connection metadata nobody chose to
    // publish; `message` alone stays useful for logs/non-prod debugging and
    // safe once `getDescription` gates `details.message` to non-production
    // (same issue).
    throw new AppError('Uppload: read error', { code: 'REPOSITORY_ERROR', details: { message: err?.message } });
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
 *   (e.g. `{ filename }`); `null`/`undefined`/`{}` are also valid — all
 *   resolve to a lookup that matches nothing and hit the no-op path below
 * @return {Object} a no-op marker ({ deletedCount: 0, notFound: true }) when
 *   no matching file was found, or otherwise whatever the underlying GridFS
 *   bucket delete resolves with (unchanged from before this no-op path was
 *   added — callers on the delete-success path never relied on a specific
 *   shape here)
 */
const remove = async (upload) => {
  const lookup = upload ?? null;
  const filename = upload?.filename;
  // `filename` is undefined (not just falsy-but-present) whenever `upload`
  // itself was null/undefined/{} — logging the ORIGINAL lookup argument
  // (captured above, before it may get reassigned below) keeps this debug
  // line useful in that case instead of showing `filename: undefined` with
  // no other context.
  /**
   * @desc Builds the no-op response for `remove()` when no matching file was
   *  found, logging the original lookup argument at debug first.
   * @returns {Object} the no-op marker { deletedCount: 0, notFound: true }
   */
  const noOp = () => {
    logger.debug('Upload: remove - no matching file, treating as already removed', { filename: filename ?? null, lookup });
    return { deletedCount: 0, notFound: true };
  };
  if (!upload || !upload._id) {
    // A lookup key that carries neither `_id` nor a string `filename` can
    // never resolve to a real record — short-circuit BEFORE querying rather
    // than asking Mongoose to filter on `{ filename: undefined }`. This
    // repo's own Mongoose version was verified end-to-end to handle that
    // filter safely (returns no match, never an arbitrary document), but
    // exact handling of an undefined-valued filter key has shifted across
    // Mongoose/MongoDB-driver versions — skipping the query entirely removes
    // any dependence on that behavior for a lookup that was never going to
    // resolve to anything anyway.
    if (typeof filename !== 'string' || filename.length === 0) return noOp();
    upload = await Uploads.findOne({ filename }).exec();
  }
  if (!upload) return noOp();
  try {
    const unlinked = await bucket.delete(upload._id);
    return unlinked;
  } catch (err) {
    // Curated (issue #4059) — see the identical comment on getStream above.
    throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: { message: err?.message } });
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
      // Curated (issue #4059) — see the identical comment on getStream above.
      throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: { message: err?.message } });
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
      // Curated (issue #4059) — see the identical comment on getStream above.
      throw new AppError('Upload: delete error', { code: 'REPOSITORY_ERROR', details: { message: err?.message } });
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
 * Known trade-off (accepted, not fixed here): the reference-Set snapshot is
 * taken at the START of the run, then read against for the whole candidate
 * scan. A blob whose age already exceeds `graceMs` — i.e. NOT protected by
 * the grace window, which only covers the gap between a blob's own write and
 * its first reference — that gets referenced by a brand-new document for the
 * FIRST TIME after the snapshot but before the scan reaches it will still
 * look unreferenced and get deleted. Closing this would need either a
 * point-in-time consistent read across both passes (session/causal
 * consistency) or re-checking each candidate's reference status
 * transactionally right before delete — real complexity for a scenario this
 * sweep's intended use (referencing a blob at write time, not reattaching a
 * reference to an already-old, already-orphaned one later) does not
 * exercise. Not addressed without a product decision to actually protect
 * against it.
 *
 * @param {String} kind - metadata.kind to sweep (e.g. 'htmlSnapshot')
 * @param {String} collection - name of the collection to check references against
 * @param {String[]} paths - dot-paths on `collection` docs that may reference an upload's filename
 * @param {Number} graceMs - minimum age (ms, from GridFS `uploadDate`) before an unreferenced blob is eligible for deletion
 * @returns {Promise<Object>} counters — { scanned, referenced, orphaned, deleted, deleteFailed, skippedTooYoung }.
 *   `deleteFailed` lets a caller detect a partial sweep (some eligible blobs
 *   left undeleted after a transient bucket error) instead of a `deleted`
 *   count that silently looks complete.
 */
const purgeUnreferenced = async (kind, collection, paths, graceMs) => {
  // A missing/empty `kind` would make `Uploads.find({ 'metadata.kind': kind })`
  // below match every upload of every kind instead of quietly matching none —
  // the same "must fail loudly, not silently look like a clean/empty result"
  // requirement already applied to `collection` and `paths`.
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new AppError('Upload: purgeUnreferenced requires a non-empty kind', { code: 'REPOSITORY_ERROR' });
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AppError('Upload: purgeUnreferenced requires at least one reference path', { code: 'REPOSITORY_ERROR' });
  }
  // A non-string or empty path would build a nonsensical field reference
  // (`toArrayExpr` does `` `$${path}` `` unconditionally) rather than failing
  // clearly — same "fail loudly" requirement as `kind`/`collection`/`graceMs`.
  if (!paths.every((path) => typeof path === 'string' && path.length > 0)) {
    throw new AppError('Upload: purgeUnreferenced requires every reference path to be a non-empty string', { code: 'REPOSITORY_ERROR' });
  }
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new AppError('Upload: purgeUnreferenced requires a non-negative graceMs', { code: 'REPOSITORY_ERROR' });
  }

  /* A mistyped `collection` name would make the aggregation below return an
   * EMPTY cursor — every candidate would then look unreferenced and get
   * deleted once past the grace window. That failure mode is silent DATA
   * LOSS. Fail loudly instead. */
  const collectionExists = await mongoose.connection.db
    .listCollections({ name: collection }, { nameOnly: true })
    .hasNext();
  if (!collectionExists) {
    throw new AppError(`Upload: purgeUnreferenced target collection "${collection}" does not exist`, { code: 'REPOSITORY_ERROR' });
  }

  /**
   * @desc Normalises a reference path's value to an array: missing/null ->
   *  [], an array field (e.g. across subdocuments) -> itself, a scalar ->
   *  [value].
   * @param {String} path - dot-path on a `collection` document
   * @returns {Object} an aggregation expression resolving to an array of reference values
   */
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
  // `noCursorTimeout` — this streams the WHOLE collection at cron/batch
  // scale, not request-path scale; without it, MongoDB closes an idle
  // cursor after 10 minutes and a slow pass over a large `collection` fails
  // mid-run with the counters accumulated so far lost.
  const referenceCursor = mongoose.connection.db.collection(collection).aggregate(
    [
      { $project: { _id: 0, refs: { $concatArrays: paths.map(toArrayExpr) } } },
      { $match: { 'refs.0': { $exists: true } } },
    ],
    { noCursorTimeout: true },
  );
  for await (const doc of referenceCursor) {
    for (const filename of doc.refs) {
      if (typeof filename === 'string') referenced.add(filename);
    }
  }

  const now = Date.now();
  let scanned = 0;
  let referencedCount = 0;
  let deleted = 0;
  let deleteFailed = 0;
  let skippedTooYoung = 0;

  const candidateCursor = Uploads.find({ 'metadata.kind': kind }, null, { noCursorTimeout: true })
    .select('filename uploadDate')
    .lean()
    .cursor();
  for await (const candidate of candidateCursor) {
    scanned += 1;
    if (referenced.has(candidate.filename)) {
      referencedCount += 1;
      continue;
    }
    // Missing uploadDate is treated as "unknown age" -> never eligible for
    // deletion (fail closed, not open) rather than as "very old".
    const ageMs = candidate.uploadDate ? now - new Date(candidate.uploadDate).getTime() : -1;
    if (ageMs < graceMs) {
      skippedTooYoung += 1;
      continue;
    }
    try {
      await bucket.delete(candidate._id);
      deleted += 1;
    } catch (err) {
      // Logged (not just counted): a caught delete failure that a caller
      // never inspects the counters for would otherwise vanish with no
      // record of which file failed. `deleteFailed` lets a caller detect a
      // partial sweep programmatically; the log gives the "which one".
      deleteFailed += 1;
      logger.error('Upload: purgeUnreferenced - delete failed', {
        filename: candidate.filename,
        kind,
        error: err?.message,
      });
    }
  }

  // orphaned is derivable — every scanned candidate is either referenced or
  // orphaned, no third state — so it's computed once here rather than
  // tracked as its own mutable counter through the loop. Within "orphaned",
  // deleted + deleteFailed + skippedTooYoung together account for the total.
  const orphaned = scanned - referencedCount;
  // Only the counters are returned — summary observability is the caller's
  // concern (this repository has no other function that logs on success;
  // the per-item `logger.error` above is the one exception, kept because a
  // caught delete failure here is otherwise swallowed with no record of it).
  return { scanned, referenced: referencedCount, orphaned, deleted, deleteFailed, skippedTooYoung };
};

export default {
  list,
  get,
  getStream,
  update,
  remove,
  deleteMany,
  purge,
  purgeUnreferenced,
};
