/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
          { firstName: { $regex: escapeRegex(search), $options: 'i' } },
          { lastName: { $regex: escapeRegex(search), $options: 'i' } },
          { email: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};
  return User.find(filter)
    .limit(perPage)
    .skip(perPage * page || 0)
    .select('-password -providerData')
    .populate('currentOrganization', 'name')
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
 * @desc Function to get a user from db by id, email, or token
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
  if (user.emailVerificationToken) {
    return User.findOne({
      emailVerificationToken: user.emailVerificationToken,
      emailVerificationExpires: {
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
const update = (user) => {
  if (user._id) {
    return User.findByIdAndUpdate(user._id, user, { new: true, runValidators: true }).exec();
  }
  return new User(user).save();
};

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
 * @return {Promise<number>} estimated document count
 */
const stats = () => User.estimatedDocumentCount().exec();

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

/**
 * @desc Function to search users by name or email with a regex
 * @param {String} search - The search string
 * @return {Array} matching user IDs
 */
const searchByNameOrEmail = (search) => {
  const regex = new RegExp(escapeRegex(search), 'i');
  return User.find({
    $or: [{ email: regex }, { firstName: regex }, { lastName: regex }],
  }).select('_id').exec();
};

/**
 * @desc Function to find a user by email address
 * @param {String} email - The email to search for
 * @return {Promise<Object|null>} The matching user or null
 */
const findByEmail = (email) => User.findOne({ email });

/**
 * @desc Function to update a user by ID with a partial update object
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @return {Object} update result
 */
const updateById = (id, data) => User.updateOne({ _id: id }, data).exec();

/**
 * @desc Function to find a user by ID, update, and return the populated document
 * @param {String} id - The user ID
 * @param {Object} data - Fields to update
 * @param {String|Array|Object} populateFields - Fields to populate
 * @return {Object} updated user
 */
const findByIdAndUpdatePopulated = (id, data, populateFields) =>
  User.findByIdAndUpdate(id, data, { new: true }).populate(populateFields).exec();

/**
 * @desc Function to find users matching a filter with optional field selection
 * @param {Object} filter - Mongoose filter
 * @param {String} [select] - Fields to select
 * @return {Array} matching users
 */
const findWithFilter = (filter, select) => User.find(filter).select(select || '').exec();

/**
 * @desc Function to update multiple users matching a filter
 * @param {Object} filter - Mongoose filter
 * @param {Object} data - Fields to update
 * @return {Object} update result
 */
const updateMany = (filter, data) => User.updateMany(filter, data).exec();

export default {
  list,
  create,
  get,
  search,
  update,
  remove,
  stats,
  push,
  searchByNameOrEmail,
  findByEmail,
  updateById,
  findByIdAndUpdatePopulated,
  findWithFilter,
  updateMany,
};
