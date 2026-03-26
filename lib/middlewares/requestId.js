/**
 * Module dependencies
 */
import { randomUUID } from 'crypto';

/**
 * Express middleware that assigns a unique request ID to every incoming request.
 * If the client sends an `X-Request-ID` header, that value is reused; otherwise
 * a new UUID v4 is generated.  The ID is exposed as `req.id` and echoed back
 * via the `X-Request-ID` response header for end-to-end tracing.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requestId = (req, res, next) => {
  const id = req.headers['x-request-id'] || randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
};

export default requestId;
