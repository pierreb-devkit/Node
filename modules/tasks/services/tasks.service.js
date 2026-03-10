/**
 * Module dependencies
 */
import TasksRepository from '../repositories/tasks.repository.js';

/**
 * @function list
 * @description Service to retrieve all tasks in the database.
 * When an organization context is provided, only tasks belonging to that
 * organization are returned. Without an organization context all tasks
 * are returned (backward compatible).
 * @param {Object} [organization] - Optional organization document whose _id is used to filter tasks.
 * @return {Promise} A promise that resolves to the list of tasks
 */
const list = async (organization) => {
  const filter = organization ? { organizationId: organization._id } : {};
  const result = await TasksRepository.list(filter);
  return Promise.resolve(result);
};

/**
 * @function create
 * @description Service to create a new task.
 * When an organization context is provided, the task is scoped to that
 * organization by setting its organizationId field.
 * @param {Object} body - The object containing task details such as title and description.
 * @param {Object} user - The user creating the task.
 * @param {Object} [organization] - Optional organization document to scope the task.
 * @returns {Promise} A promise resolving to the newly created task.
 */
const create = async (body, user, organization) => {
  const task = {};
  task.title = body.title;
  task.description = body.description;
  task.user = user.id;
  if (organization) {
    task.organizationId = organization._id;
  }

  const result = await TasksRepository.create(task);
  return Promise.resolve(result);
};

/**
 * @function get
 * @description Service to fetch a single task by its ID.
 * @param {String} id - The ID of the task to fetch.
 * @returns {Promise} A promise resolving to the retrieved task.
 */
const get = async (id) => {
  const result = await TasksRepository.get(id);
  return Promise.resolve(result);
};

/**
 * @function update
 * @description Service to update an existing task.
 * @param {Object} task - The existing task object.
 * @param {Object} body - The object containing updated task details.
 * @returns {Promise} A promise resolving to the updated task.
 */
const update = async (task, body) => {
  task.title = body.title;
  task.description = body.description;

  const result = await TasksRepository.update(task);
  return Promise.resolve(result);
};

/**
 * @function remove
 * @description Service to delete a task.
 * @param {Object} task - The task to delete.
 * @returns {Promise} A promise resolving to a confirmation of the deletion.
 */
const remove = async (task) => {
  const result = await TasksRepository.remove(task);
  return Promise.resolve(result);
};

/**
 * @function stats
 * @description Service to fetch statistical data about tasks in the database.
 * @returns {Promise} A promise resolving to the statistical data.
 */
const stats = async () => {
  const result = await TasksRepository.stats();
  return Promise.resolve(result);
};

export default {
  list,
  create,
  get,
  update,
  remove,
  stats,
};
