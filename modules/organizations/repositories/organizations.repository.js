/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Organization = mongoose.model('Organization');

const defaultPopulate = [
  {
    path: 'createdBy',
    select: 'email firstName lastName',
  },
];

/**
 * @function list
 * @description Data access operation to fetch all organizations matching an optional filter.
 * @param {Object} [filter] - Optional filter to apply to the query.
 * @returns {Promise<Array>} An array of organizations.
 */
const list = (filter) => Organization.find(filter).populate(defaultPopulate).sort('-createdAt').exec();

/**
 * @function create
 * @description Data access operation to create a new organization in the database.
 * @param {Object} organization - The organization object to create.
 * @returns {Promise<Object>} The created organization.
 */
const create = (organization) => new Organization(organization).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function get
 * @description Data access operation to fetch a single organization by its ID.
 * @param {String} id - The ID of the organization to fetch.
 * @returns {Object|null} The retrieved organization or null if the ID is not valid.
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Organization.findOne({ _id: id }).populate(defaultPopulate).exec();
};

/**
 * @function update
 * @description Data access operation to update an existing organization in the database.
 * @param {Object} organization - The organization object containing the updated details.
 * @returns {Promise<Object>} The updated organization.
 */
const update = (organization) => new Organization(organization).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function remove
 * @description Data access operation to delete a single organization by its ID.
 * @param {Object} organization - The organization object to delete.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const remove = (organization) => Organization.deleteOne({ _id: organization.id || organization._id }).exec();

/**
 * @function deleteMany
 * @description Data access operation to delete multiple organizations based on a filter.
 * @param {Object} filter - The filter to apply to the deletion query.
 * @returns {Promise<Object>} A confirmation of the deletion.
 */
const deleteMany = (filter) => {
  if (filter) return Organization.deleteMany(filter).exec();
};

export default {
  list,
  create,
  get,
  update,
  remove,
  deleteMany,
};
