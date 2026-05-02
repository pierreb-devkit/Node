/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, afterEach, test, expect, jest } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';
import { up as backfillPlanVersionSnapshots } from '../migrations/20260502110000-backfill-plan-version-snapshots.js';

/**
 * Integration tests for BillingPlan snapshot backfill migration.
 */
describe('BillingPlan backfill migration integration tests:', () => {
  let collection;

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    collection = mongoose.connection.db.collection('billingplans');
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('backfills canonical version, ratios, and meterQuota when version is null', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    await collection.insertOne({
      planId: 'pro',
      version: null,
      meterQuota: 1,
      ratios: {},
      active: true,
      effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
      effectiveUntil: null,
    });

    await backfillPlanVersionSnapshots();

    const doc = await collection.findOne({ planId: 'pro' });
    expect(doc.version).toBe('2026.05');
    expect(doc.ratios).toEqual({ default: 1 });
    expect(doc.meterQuota).toBe(500000);
  });

  test('is idempotent when re-run after canonical snapshot is applied', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    await collection.insertOne({
      planId: 'starter',
      version: null,
      meterQuota: 1,
      ratios: {},
      active: true,
      effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
      effectiveUntil: null,
    });

    await backfillPlanVersionSnapshots();
    const first = await collection.findOne({ planId: 'starter' });

    await backfillPlanVersionSnapshots();
    const second = await collection.findOne({ planId: 'starter' });

    expect(second).toEqual(first);
    expect(await collection.countDocuments({ planId: 'starter' })).toBe(1);
  });
});
