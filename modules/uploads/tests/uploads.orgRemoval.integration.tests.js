/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';
import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Org removal cleans the removed organization's uploads (#4306): the uploads
 * org-removal handler (registered by uploads.init at boot) deletes every org-scoped
 * file — metadata record AND chunks — whether the id was stored as an ObjectId or a
 * string, and never touches another organization's files or uploads with no org.
 */
describe('Uploads org-removal cleanup integration tests:', () => {
  let OrganizationsService;
  let UploadsService;
  let Organization;
  let Uploads;
  let UploadsChunks;
  const created = [];

  const removedId = new mongoose.Types.ObjectId();
  const keptId = new mongoose.Types.ObjectId();

  /**
   * Store a small file through the real write path.
   * @param {Object} metadata - GridFS metadata (organizationId, user, ...)
   * @returns {Promise<Object>} the stored file document
   */
  const store = async (metadata) => {
    const file = await UploadsService.createFromBuffer(Buffer.from('x'.repeat(64)), 'image/png', 'avatar', metadata);
    created.push(file._id);
    return file;
  };

  beforeAll(async () => {
    await bootstrap();
    OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.crud.service.js'))).default;
    UploadsService = (await import(path.resolve('./modules/uploads/services/uploads.service.js'))).default;
    Organization = mongoose.model('Organization');
    Uploads = mongoose.model('Uploads');
    UploadsChunks = mongoose.model('UploadsChunks');
    await Organization.deleteMany({ _id: { $in: [removedId, keptId] } });
    await Organization.create({ _id: removedId, name: 'Uploads Gone', slug: 'uploads-org-removal-gone', plan: 'free' });
    await Organization.create({ _id: keptId, name: 'Uploads Kept', slug: 'uploads-org-removal-kept', plan: 'free' });
  });

  afterAll(async () => {
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    for (const id of created) {
      try { await bucket.delete(id); } catch (_) { /* already removed */ }
    }
    await Organization.deleteMany({ _id: { $in: [removedId, keptId] } });
    await mongooseService.disconnect();
  });

  test('removing an organization deletes its files and chunks only', async () => {
    const asObjectId = await store({ organizationId: removedId });
    const asString = await store({ organizationId: String(removedId) });
    const otherOrg = await store({ organizationId: keptId });
    const noOrg = await store({ user: new mongoose.Types.ObjectId() });

    const organization = await Organization.findById(removedId);
    await OrganizationsService.remove(organization);

    for (const gone of [asObjectId, asString]) {
      expect(await Uploads.countDocuments({ _id: gone._id })).toBe(0);
      expect(await UploadsChunks.countDocuments({ files_id: gone._id })).toBe(0);
    }
    for (const kept of [otherOrg, noOrg]) {
      expect(await Uploads.countDocuments({ _id: kept._id })).toBe(1);
      expect(await UploadsChunks.countDocuments({ files_id: kept._id })).toBeGreaterThan(0);
    }
  });
});
