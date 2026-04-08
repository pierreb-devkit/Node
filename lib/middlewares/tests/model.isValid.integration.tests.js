/**
 * Module dependencies.
 */
import { jest, beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

/**
 * Integration tests for model.isValid middleware.
 * Boots a minimal Express app with the middleware mounted to validate
 * real HTTP request/response lifecycle behaviour for key preservation.
 */
describe('model.isValid integration tests:', () => {
  let app;

  beforeAll(async () => {
    jest.resetModules();

    const { default: model } = await import('../model.js');

    const schema = z.object({
      title: z.string().min(1),
      description: z.string().default(''),
      status: z.string().default('draft'),
    });

    app = express();
    app.use(express.json());

    app.put('/api/items/:id', model.isValid(schema), (req, res) => {
      res.json(req.body);
    });

    app.post('/api/items', model.isValid(schema), (req, res) => {
      res.status(201).json(req.body);
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('PUT should preserve only original keys and not inject defaults', async () => {
    const res = await request(app)
      .put('/api/items/123')
      .send({ title: 'updated' })
      .expect(200);

    expect(res.body).toEqual({ title: 'updated' });
    expect(res.body).not.toHaveProperty('description');
    expect(res.body).not.toHaveProperty('status');
  });

  test('PUT should keep explicitly sent keys with Zod-transformed values', async () => {
    const res = await request(app)
      .put('/api/items/123')
      .send({ title: 'updated', description: 'new desc' })
      .expect(200);

    expect(res.body).toEqual({ title: 'updated', description: 'new desc' });
    expect(res.body).not.toHaveProperty('status');
  });

  test('POST should include Zod defaults for absent keys', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ title: 'new item' })
      .expect(201);

    expect(res.body).toEqual({
      title: 'new item',
      description: '',
      status: 'draft',
    });
  });

  test('POST should use client values over defaults when provided', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ title: 'new', description: 'custom', status: 'published' })
      .expect(201);

    expect(res.body).toEqual({
      title: 'new',
      description: 'custom',
      status: 'published',
    });
  });

  test('should return 422 on validation failure', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ title: '' })
      .expect(422);

    expect(res.body).toHaveProperty('message');
  });
});
