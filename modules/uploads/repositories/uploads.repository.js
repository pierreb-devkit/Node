/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import AppError from '../../../lib/helpers/AppError.js';

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
 * @desc Function to remove an upload from db
 * @param {Object} upload
 * @return {Object} confirmation of delete
 */
const remove = async (upload) => {
  if (!upload || !upload._id) upload = await Uploads.findOne({ filename: upload.filename }).exec();
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

export default {
  list,
  get,
  getStream,
  update,
  remove,
  deleteMany,
  purge,
};
