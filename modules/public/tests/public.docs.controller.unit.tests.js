/**
 * Unit tests for the public docs controller.
 * Focuses on HTTP response shaping — delegates loading to the service.
 */
import {
  jest, describe, test, expect, beforeEach,
} from '@jest/globals';

const getTree = jest.fn();
const getMarkdown = jest.fn();

jest.unstable_mockModule('../services/public.docs.service.js', () => ({
  default: {
    getTree, getMarkdown, clearCache: jest.fn(), _internals: {},
  },
}));

const controller = (await import('../controllers/public.docs.controller.js')).default;

/**
 * Build a chainable Express response double (status/json/send/set all return `res`).
 * @returns {{ status: jest.Mock, json: jest.Mock, send: jest.Mock, set: jest.Mock }}
 */
const mockResponse = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.set = jest.fn(() => res);
  return res;
};

describe('PublicDocsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('tree: returns 200 with the service payload wrapped in a success envelope', async () => {
    const payload = { categories: [{ id: 'get-started', label: 'Get Started', order: 0, guides: [] }] };
    getTree.mockReturnValueOnce(payload);
    const res = mockResponse();

    await controller.tree({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      type: 'success',
      message: 'public docs',
      data: payload,
    });
  });

  test('tree: sets Cache-Control: public, max-age=300 on a 200 response', async () => {
    getTree.mockReturnValueOnce({ categories: [] });
    const res = mockResponse();

    await controller.tree({ query: {} }, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
  });

  test('tree: returns 503 when the service throws', async () => {
    getTree.mockImplementationOnce(() => { throw new Error('disk gone'); });
    const res = mockResponse();

    await controller.tree({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const [body] = res.json.mock.calls[0];
    expect(body.type).toBe('error');
    expect(body.status).toBe(503);
  });

  test('raw: returns markdown with text/markdown content type for a known slug', async () => {
    getMarkdown.mockReturnValueOnce('# Body\n\nText.');
    const res = mockResponse();

    await controller.raw({ params: { slug: 'quickstart' } }, res);

    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('# Body\n\nText.');
  });

  test('raw: sets Cache-Control: public, max-age=300 on a 200 response', async () => {
    getMarkdown.mockReturnValueOnce('# Guide\n\nProse.');
    const res = mockResponse();

    await controller.raw({ params: { slug: 'quickstart' } }, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
  });

  test('raw: does NOT set Cache-Control on a 404 response', async () => {
    getMarkdown.mockReturnValueOnce(null);
    const res = mockResponse();

    await controller.raw({ params: { slug: 'nope' } }, res);

    const cacheControlCalls = res.set.mock.calls.filter(([header]) => header === 'Cache-Control');
    expect(cacheControlCalls).toHaveLength(0);
  });

  test('raw: returns 404 for an unknown slug', async () => {
    getMarkdown.mockReturnValueOnce(null);
    const res = mockResponse();

    await controller.raw({ params: { slug: 'nope' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    const [body] = res.json.mock.calls[0];
    expect(body.type).toBe('error');
    expect(body.status).toBe(404);
  });

  test('raw: returns 503 when the service throws', async () => {
    getMarkdown.mockImplementationOnce(() => { throw new Error('disk gone'); });
    const res = mockResponse();

    await controller.raw({ params: { slug: 'quickstart' } }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const [body] = res.json.mock.calls[0];
    expect(body.type).toBe('error');
    expect(body.status).toBe(503);
  });
});
