/**
 * Module dependencies
 */
import { randomUUID } from 'crypto';

/**
 * Validate that a request ID is safe for use in logs and headers.
 * Accepts alphanumeric characters, dashes, and underscores up to 128 chars.
 * @param {string} id - Candidate request ID
 * @returns {boolean} true if the ID is valid
 */
const isValidRequestId = (id) => typeof id === 'string' && id.length <= 128 && /^[\w-]+$/.test(id);

/**
 * Express middleware that assigns a unique request ID to every incoming request.
 * If the client sends a valid `X-Request-ID` header, that value is reused;
 * otherwise a new UUID v4 is generated.  The ID is exposed as `req.id` and
 * echoed back via the `X-Request-ID` response header for end-to-end tracing.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requestId = (req, res, next) => {
  const clientId = req.headers['x-request-id'];
  const id = (clientId && isValidRequestId(clientId)) ? clientId : randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
};

export default requestId;
