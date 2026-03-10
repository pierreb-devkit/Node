/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import TasksService from '../services/tasks.service.js';

/**
 * @function list
 * @description Endpoint to fetch a list of tasks from the service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws Will throw an error if the task service fails to fetch the list of tasks
 */
const list = async (req, res) => {
  try {
    const tasks = await TasksService.list();
    responses.success(res, 'task list')(tasks);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function create
 * @description Endpoint to create a new task
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws Will throw an error if the task service fails to create the task
 */
const create = async (req, res) => {
  try {
    const task = await TasksService.create(req.body, req.user);
    responses.success(res, 'task created')(task);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function get
 * @description Endpoint to fetch the current task
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const get = (req, res) => {
  const task = req.task ? req.task.toJSON() : {};
  responses.success(res, 'task get')(task);
};

/**
 * @function update
 * @description Endpoint to update an existing task
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws Will throw an error if the task service fails to update the task
 */
const update = async (req, res) => {
  // TODO if (req.task && req.user && req.task.user && req.task.user.id === req.user.id) next();
  try {
    const task = await TasksService.update(req.task, req.body);
    responses.success(res, 'task updated')(task);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function remove
 * @description Endpoint to remove an existing task
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws Will throw an error if the task service fails to remove the task
 */
const remove = async (req, res) => {
  try {
    const result = await TasksService.remove(req.task);
    result.id = req.task.id;
    responses.success(res, 'task deleted')({ id: req.task.id, ...result });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function stats
 * @description Endpoint to fetch the statistics of tasks
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @throws Will throw an error if the task service fails to fetch the statistics
 */
const stats = async (req, res) => {
  const data = await TasksService.stats();
  if (!data.err) {
    responses.success(res, 'tasks stats')(data);
  } else {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(data.err))(data.err);
  }
};

/**
 * @function taskByID
 * @description Middleware to fetch a task by its ID from the service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - ID of the task to fetch
 * @throws Will throw an error if the task service fails to fetch the task
 */
const taskByID = async (req, res, next, id) => {
  try {
    const task = await TasksService.get(id);
    if (!task) responses.error(res, 404, 'Not Found', 'No Task with that identifier has been found')();
    else {
      req.task = task;
      next();
    }
  } catch (err) {
    next(err);
  }
};

export default {
  list,
  create,
  get,
  update,
  remove,
  stats,
  taskByID,
};
