/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { MEMBERSHIP_STATUSES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * Model-level consent guard (P5a — #3813).
 *
 * The Membership model's pre('validate') hook MUST reject a PENDING membership that
 * carries no `source` — without it, an owner_add that forgot to set source would be
 * indistinguishable from a join_request and could be approved by the owner (consent
 * bypass). These tests run real mongoose validation (no DB write) against the model
 * registered at bootstrap, so a reverted guard fails them.
 */
describe('Membership model consent guard (pre-validate source):', () => {
  let Membership;
  const orgId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await bootstrap();
    Membership = mongoose.model('Membership');
  });

  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  test('REJECTS a PENDING membership with no source (the consent guard)', async () => {
    const doc = new Membership({ userId, organizationId: orgId, status: MEMBERSHIP_STATUSES.PENDING });
    await expect(doc.validate()).rejects.toThrow('PENDING membership requires explicit source');
  });

  test('ACCEPTS a PENDING owner_add membership', async () => {
    const doc = new Membership({
      userId,
      organizationId: orgId,
      status: MEMBERSHIP_STATUSES.PENDING,
      source: PENDING_SOURCES.OWNER_ADD,
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('ACCEPTS a PENDING join_request membership', async () => {
    const doc = new Membership({
      userId,
      organizationId: orgId,
      status: MEMBERSHIP_STATUSES.PENDING,
      source: PENDING_SOURCES.JOIN_REQUEST,
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('ACCEPTS an ACTIVE membership with no source (source only matters while PENDING)', async () => {
    const doc = new Membership({ userId, organizationId: orgId, status: MEMBERSHIP_STATUSES.ACTIVE });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('the default status is active — so an add MUST set PENDING explicitly', () => {
    // A bare membership defaults to active (the reason addMember sets status explicitly).
    const doc = new Membership({ userId, organizationId: orgId });
    expect(doc.status).toBe(MEMBERSHIP_STATUSES.ACTIVE);
  });

  test('REJECTS an unknown source value (enum guard)', async () => {
    const doc = new Membership({
      userId,
      organizationId: orgId,
      status: MEMBERSHIP_STATUSES.PENDING,
      source: 'not_a_real_source',
    });
    await expect(doc.validate()).rejects.toThrow();
  });
});
