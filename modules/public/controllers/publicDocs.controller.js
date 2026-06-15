/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import PublicDocsService from '../services/publicDocs.service.js';

/**
 * @desc GET /api/public/docs — public, unauthenticated docs content tree.
 * Returns the guide catalogue grouped into categories:
 * `{ categories: [ { id, label, order, guides: [ { slug, title, persona, order, summary } ] } ] }`.
 * Built from on-disk markdown and cached in-process (~5min).
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {void}
 */
const tree = async (req, res) => {
  try {
    const payload = PublicDocsService.getTree();
    res.set('Cache-Control', 'public, max-age=300');
    return responses.success(res, 'public docs')(payload);
  } catch (err) {
    return responses.error(res, 503, 'Service Unavailable', errors.getMessage(err))(err);
  }
};

/**
 * @desc GET /api/public/docs/:slug.md — raw markdown body for a single guide.
 * Responds with `Content-Type: text/markdown` and the prose body (the leading
 * H1 stripped; guides carry no front-matter). Unknown slug → 404.
 * @param {Object} req - Express request (`req.params.slug`)
 * @param {Object} res - Express response
 * @returns {void}
 */
const raw = async (req, res) => {
  try {
    const markdown = PublicDocsService.getMarkdown(req.params.slug);
    if (markdown === null) {
      return responses.error(res, 404, 'Not Found', 'Unknown guide')();
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(markdown);
  } catch (err) {
    return responses.error(res, 503, 'Service Unavailable', errors.getMessage(err))(err);
  }
};

export default {
  tree,
  raw,
};
