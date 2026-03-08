/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const User = mongoose.model('User');

/**
 * @desc Function to get all user in db
 * @param {String} search
 * @param {Int} page
 * @param {Int} perPage
 * @return {Array}  users selected
 */
const list = (search, page, perPage) => {
  const filter = search
    ? {
        $or: [
          { firstName: { $regex: `${search}`, $options: 'i' } },
          { lastName: { $regex: `${search}`, $options: 'i' } },
          { email: { $regex: `${search}`, $options: 'i' } },
        ],
      }
    : {};
  return User.find(filter)
    .limit(perPage)
    .skip(perPage * page || 0)
    .select('-password -providerData')
    .sort('-createdAt')
    .exec();
};

/**
 * @desc Function to create a user in db
 * @param {Object} user
 * @return {Object} user
 */
const create = (user) => new User(user).save();

/**
 * @desc Function to get a user from db by id or email
 * @param {Object} user
 * @return {Object} user
 */
const get = (user) => {
  if (user.id && mongoose.Types.ObjectId.isValid(user.id)) return User.findOne({ _id: user.id }).exec();
  if (user.email) return User.findOne({ email: user.email }).exec();
  if (user.resetPasswordToken) {
    return User.findOne({
      resetPasswordToken: user.resetPasswordToken,
      resetPasswordExpires: {
        $gt: Date.now(),
      },
    }).exec();
  }
};

/**
 * @desc Function to get a search in db request
 * @param {Object} mongoose input request
 * @return {Array} users
 */
const search = (input) => User.find(input).exec();

/**
 * @desc Function to update a user in db
 * @param {Object} user
 * @return {Object} user
 */
const update = (user) => new User(user).save();

/**
 * @desc Function to remove a user from db by id or email
 * @param {Object} user
 * @return {Object} confirmation of delete
 */
const remove = async (user) => {
  if (user && user.id && mongoose.Types.ObjectId.isValid(user.id)) return User.deleteOne({ _id: user.id }).exec();
  if (user && user.email) return User.deleteOne({ email: user.email }).exec();
};

/**
 * @desc Function to get collection stats
 * @returns {Promise<number>} estimated document count
 */
const stats = () => User.estimatedDocumentCount();

/**
 * @desc Function to push list of users in db
 * @param {[Object]} users
 * @param {[String]} filters
 * @return {Object} locations
 */
const push = (users, filters) =>
  User.bulkWrite(
    users.map((user) => {
      const filter = {};
      filters.forEach((value) => {
        filter[value] = user[value];
      });
      return {
        updateOne: {
          filter,
          update: user,
          upsert: true,
        },
      };
    }),
  );

export default {
  list,
  create,
  get,
  search,
  update,
  remove,
  stats,
  push,
};
