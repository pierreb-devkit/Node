/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import OrganizationsService from '../services/organizations.service.js';
import MembershipService from '../services/organizations.membership.service.js';

/**
 * @function list
 * @description Endpoint to fetch the list of organizations the current user belongs to.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const list = async (req, res) => {
  try {
    const organizations = await OrganizationsService.listByUser(req.user);
    responses.success(res, 'organization list')(organizations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function create
 * @description Endpoint to create a new organization. The creator becomes the owner.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const create = async (req, res) => {
  try {
    const organization = await OrganizationsService.create(req.body, req.user);
    responses.success(res, 'organization created')(organization);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function get
 * @description Endpoint to fetch the current organization loaded by the param middleware.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const get = (req, res) => {
  const organization = req.organization ? req.organization.toJSON() : {};
  responses.success(res, 'organization get')(organization);
};

/**
 * @function update
 * @description Endpoint to update an existing organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const update = async (req, res) => {
  try {
    const organization = await OrganizationsService.update(req.organization, req.body);
    responses.success(res, 'organization updated')(organization);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function remove
 * @description Endpoint to delete an existing organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const remove = async (req, res) => {
  try {
    const result = await OrganizationsService.remove(req.organization);
    responses.success(res, 'organization deleted')({ id: req.organization.id, ...result });
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function adminList
 * @description Platform admin endpoint to list all organizations.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const adminList = async (req, res) => {
  try {
    const organizations = await OrganizationsService.list();
    responses.success(res, 'organization list')(organizations);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @function organizationByID
 * @description Middleware to fetch an organization by its ID from the service.
 * Also loads the current user's membership for this organization.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} id - ID of the organization to fetch
 * @returns {void}
 */
const organizationByID = async (req, res, next, id) => {
  try {
    const organization = await OrganizationsService.get(id);
    if (!organization) responses.error(res, 404, 'Not Found', 'No Organization with that identifier has been found')();
    else {
      req.organization = organization;
      // Load user's membership for this organization if authenticated
      if (req.user) {
        req.membership = await MembershipService.findByUserAndOrganization(req.user._id || req.user.id, id);
      }
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
  adminList,
  organizationByID,
};
