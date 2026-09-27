/**
 * Unit tests — billing.subscription.model.mongoose.js
 *
 * Regression guard: verifies the Mongoose schema declares cancelAtPeriodEnd + cancelAt.
 * Without these paths, Mongoose strict mode silently drops the fields on every save,
 * meaning pending-cancellation state is never persisted in production.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import mongoose from 'mongoose';

describe('SubscriptionMongoose schema — cancelAtPeriodEnd + cancelAt paths:', () => {
  let SubscriptionMongoose;

  // Import the model file directly — it registers itself via mongoose.model().
  // We need the raw Schema to inspect .path(), so we re-read the schema from the
  // registered model rather than importing the Schema directly (it is not exported).
  beforeAll(async () => {
    // Ensure a fresh model registration for this test file.
    // If mongoose already has a 'Subscription' model registered (e.g. from a prior jest
    // module run), delete it so our import triggers a fresh registration.
    if (mongoose.modelNames().includes('Subscription')) {
      delete mongoose.models.Subscription;
      delete mongoose.modelSchemas?.Subscription;
    }
    await import('../models/billing.subscription.model.mongoose.js');
    SubscriptionMongoose = mongoose.model('Subscription');
  });

  test('schema declares cancelAtPeriodEnd path', () => {
    const path = SubscriptionMongoose.schema.path('cancelAtPeriodEnd');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
  });

  test('schema declares cancelAt path', () => {
    const path = SubscriptionMongoose.schema.path('cancelAt');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Date');
  });
});
