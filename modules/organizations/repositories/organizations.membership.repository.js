/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Membership = mongoose.model('Membership');

const defaultPopulate = [
  {
    path: 'userId',
    select: 'email firstName lastName lastLoginAt',
  },
  {
    path: 'organizationId',
    select: 'name slug',
  },
];

/**
 * @function list
 * @description Data access operation to fetch all memberships matching a filter.
 * @param {Object} [filter] - Optional filter to apply to the query.
 * @returns {Promise<Array>} An array of memberships.
 */
const list = (filter, page, perPage) => {
  const query = Membership.find(filter).populate(defaultPopulate).sort('-createdAt');
  if (perPage) query.limit(perPage).skip((page || 0) * perPage);
  return query.exec();
};

/**
 * @function create
 * @description Data access operation to create a new membership in the database.
 * @param {Object} membership - The membership object to create.
 * @returns {Promise<Object>} The created membership.
 */
const create = (membership) => new Membership(membership).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function get
 * @description Data access operation to fetch a single membership by its ID.
 * @param {String} id - The ID of the membership to fetch.
 * @returns {Promise<Object|null>} The retrieved membership or null if the ID is not valid.
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Membership.findOne({ _id: id }).populate(defaultPopulate).exec();
};

/**
 * @function findOne
 * @description Data access operation to fetch a single membership matching a filter.
 * @param {Object} filter - The filter to apply to the query.
 * @returns {Promise<Object|null>} The found membership or null.
 */
const findOne = (filter) => Membership.findOne(filter).populate(defaultPopulate).exec();

/**
 * @function update
 * @description Data access operation to update an existing membership in the database.
 * @param {Object} membership - The membership object containing the updated details.
 * @returns {Promise<Object>} The updated membership.
 */
const update = (membership) => membership.save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function remove
 * @description Data access operation to delete a single membership by its ID.
 * @param {Object} membership - The membership object to delete.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const remove = (membership) => Membership.deleteOne({ _id: membership.id || membership._id }).exec();

/**
 * @function count
 * @description Data access operation to count memberships matching a filter.
 * @param {Object} filter - The filter to apply to the count query.
 * @returns {Promise<number>} The count of matching memberships.
 */
const count = (filter) => Membership.countDocuments(filter).exec();

/**
 * @function deleteMany
 * @description Data access operation to delete multiple memberships based on a filter.
 * @param {Object} filter - The filter to apply to the deletion query.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const deleteMany = (filter) => {
  if (!filter) throw new Error('deleteMany requires a filter');
  return Membership.deleteMany(filter).exec();
};

/**
 * @function aggregateCountByOrganizations
 * @description Data access operation to count active members per organization using aggregation.
 * @param {Array} orgIds - Array of organization IDs to count members for.
 * @returns {Promise<Array>} Array of { _id: orgId, count: number } objects.
 */
const aggregateCountByOrganizations = (orgIds) =>
  Membership.aggregate([
    { $match: { organizationId: { $in: orgIds }, status: 'active' } },
    { $group: { _id: '$organizationId', count: { $sum: 1 } } },
  ]);

/**
 * @function listByUsers
 * @description Batch-fetch active memberships for multiple user IDs in a single query.
 * @param {Array} userIds - Array of user IDs.
 * @returns {Promise<Array>} An array of memberships.
 */
const listByUsers = (userIds) =>
  Membership.find({ userId: { $in: userIds }, status: 'active' }).populate(defaultPopulate).sort('-createdAt').exec();

export default {
  list,
  create,
  get,
  findOne,
  update,
  remove,
  count,
  deleteMany,
  aggregateCountByOrganizations,
  listByUsers,
};
