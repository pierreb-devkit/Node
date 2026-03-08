/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Task = mongoose.model('Task');

const defaultPopulate = [
  {
    path: 'user',
    select: 'email firstName lastName',
  },
];

/**
 * @function list
 * @description Data access operation to fetch all tasks from the database with an optional filter.
 * @param {Object} [filter] - Optional filter to apply to the query.
 * @returns {Array} An array of tasks.
 */
const list = (filter) => Task.find(filter).populate(defaultPopulate).sort('-createdAt').exec();

/**
 * @function create
 * @description Data access operation to create a new task in the database.
 * @param {Object} task - The task object to create.
 * @returns {Object} The created task.
 */
const create = (task) => new Task(task).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function get
 * @description Data access operation to fetch a single task by its ID.
 * @param {String} id - The ID of the task to fetch.
 * @returns {Object} The retrieved task or null if the ID is not valid.
 */
const get = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Task.findOne({ _id: id }).populate(defaultPopulate).exec();
};

/**
 * @function update
 * @description Data access operation to update an existing task in the database.
 * @param {Object} task - The task object containing the updated details.
 * @returns {Object} The updated task.
 */
const update = (task) => new Task(task).save().then((doc) => doc.populate(defaultPopulate));

/**
 * @function remove
 * @description Data access operation to delete a single task by its ID.
 * @param {Object} task - The task object to delete.
 * @returns {Object} A confirmation of the deletion.
 */
const remove = (task) => Task.deleteOne({ _id: task.id }).exec();

/**
 * @function deleteMany
 * @description Data access operation to delete multiple tasks based on a filter.
 * @param {Object} filter - The filter to apply to the deletion query.
 * @returns {Object} A confirmation of the deletion.
 */
const deleteMany = (filter) => {
  if (filter) return Task.deleteMany(filter).exec();
};

/**
 * @function stats
 * @description Data access operation to get the estimated count of documents in the tasks collection.
 * @returns {Promise<number>} estimated document count
 */
const stats = () => Task.estimatedDocumentCount();

/**
 * @function push
 * @description Data access operation to update or insert multiple tasks in the database.
 * @param {Array} tasks - The array of task objects to update or insert.
 * @param {Array} filters - The array of property names to use as filters for the update.
 * @returns {Object} The result of the bulkWrite operation.
 */
const push = async (tasks, filters) =>
  Task.bulkWrite(
    tasks.map((task) => {
      const filter = {};
      filters.forEach((value) => {
        filter[value] = task[value];
      });
      return {
        updateOne: {
          filter,
          update: task,
          upsert: true,
        },
      };
    }),
  );

export default {
  list,
  create,
  get,
  update,
  remove,
  deleteMany,
  stats,
  push,
};
