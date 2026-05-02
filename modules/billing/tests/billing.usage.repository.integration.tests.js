/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';
import { up as renameConsumedHistoryIds } from '../migrations/20260502100000-rename-consumed-history-ids-to-attribution-keys.js';

/**
 * Integration tests for BillingUsageRepository migration-window replay protection.
 */
describe('BillingUsageRepository integration tests:', () => {
  let BillingUsageRepository;
  let BillingUsage;
  let collection;

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    BillingUsage = mongoose.model('BillingUsage');
    collection = mongoose.connection.db.collection('billingusages');
    await collection.createIndex(
      { organizationId: 1, weekKey: 1 },
      { unique: true, sparse: true, name: 'organizationId_1_weekKey_1' },
    );
    BillingUsageRepository = (await import('../repositories/billing.usage.repository.js')).default;
  });

  beforeEach(async () => {
    await BillingUsage.deleteMany({});
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('incrementMeter rejects legacy initial attribution before and after rename migration', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const historyId = new mongoose.Types.ObjectId();
    const weekKey = '2099-W01';
    const idempotencyKey = `${historyId.toString()}:initial`;

    await collection.insertOne({
      organizationId,
      month: '2099-01',
      weekKey,
      counters: {},
      meterUsed: 100,
      meterQuota: 1000,
      meterBreakdown: {},
      consumedHistoryIds: [historyId],
      consumedAttributionKeys: [],
    });

    const preMigrationReplay = await BillingUsageRepository.incrementMeter(
      organizationId.toString(),
      weekKey,
      25,
      {},
      idempotencyKey,
      { meterQuota: 1000, planVersion: 'v1', resetAt: null, month: '2099-01' },
    );

    expect(preMigrationReplay).toBeNull();
    let doc = await collection.findOne({ organizationId, weekKey });
    expect(doc.meterUsed).toBe(100);
    expect(doc.consumedHistoryIds).toEqual([historyId]);
    expect(doc.consumedAttributionKeys).toEqual([]);

    await renameConsumedHistoryIds();

    doc = await collection.findOne({ organizationId, weekKey });
    expect(doc.consumedHistoryIds).toBeUndefined();
    expect(doc.consumedAttributionKeys).toEqual([idempotencyKey]);

    const postMigrationReplay = await BillingUsageRepository.incrementMeter(
      organizationId.toString(),
      weekKey,
      25,
      {},
      idempotencyKey,
      { meterQuota: 1000, planVersion: 'v1', resetAt: null, month: '2099-01' },
    );

    expect(postMigrationReplay).toBeNull();
    doc = await collection.findOne({ organizationId, weekKey });
    expect(doc.meterUsed).toBe(100);
    expect(doc.consumedAttributionKeys).toEqual([idempotencyKey]);
  });
});
