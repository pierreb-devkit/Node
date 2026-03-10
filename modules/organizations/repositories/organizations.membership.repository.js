/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Membership = mongoose.model('Membership');

const defaultPopulate = [
  {
    path: 'userId',
    select: 'email firstName lastName',
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
const list = (filter) => Membership.find(filter).populate(defaultPopulate).sort('-createdAt').exec();

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
 * @returns {Object|null} The retrieved membership or null if the ID is not valid.
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
const update = (membership) => new Membership(membership).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function remove
 * @description Data access operation to delete a single membership by its ID.
 * @param {Object} membership - The membership object to delete.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const remove = (membership) => Membership.deleteOne({ _id: membership.id || membership._id }).exec();

/**
 * @function deleteMany
 * @description Data access operation to delete multiple memberships based on a filter.
 * @param {Object} filter - The filter to apply to the deletion query.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const deleteMany = (filter) => {
  if (filter) return Membership.deleteMany(filter).exec();
};

export default {
  list,
  create,
  get,
  findOne,
  update,
  remove,
  deleteMany,
};
