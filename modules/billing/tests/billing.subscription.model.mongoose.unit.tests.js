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
  // Jest isolates the module registry per test file, so `mongoose` here is always
  // a fresh instance — no prior registration to guard against.
  beforeAll(async () => {
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
