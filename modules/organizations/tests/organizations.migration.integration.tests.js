/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { up } from '../migrations/20260310120000-organizations-init.js';

/**
 * Integration tests for the organizations-init migration
 */
describe('Organizations migration integration tests:', () => {
  let User;
  let Organization;
  let Membership;
  let Task;

  beforeAll(async () => {
    try {
      await bootstrap();
      User = mongoose.model('User');
      Organization = mongoose.model('Organization');
      Membership = mongoose.model('Membership');
      Task = mongoose.model('Task');
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('up()', () => {
    let userWithoutOrganization;
    let userWithOrganization;
    let existingOrganization;
    let orphanTask;

    beforeEach(async () => {
      // Create a user who already has an organization
      userWithOrganization = await User.create({
        firstName: 'Existing',
        lastName: 'OrgUser',
        email: `existing-org-${Date.now()}@test.com`,
        provider: 'local',
      });
      existingOrganization = await Organization.create({
        name: "Existing's organization",
        slug: `existing-org-${Date.now()}`,
        createdBy: userWithOrganization._id,
      });
      await Membership.create({
        userId: userWithOrganization._id,
        organizationId: existingOrganization._id,
        role: 'owner',
      });

      // Create a user WITHOUT any membership
      userWithoutOrganization = await User.create({
        firstName: 'Orphan',
        lastName: 'User',
        email: `orphan-${Date.now()}@test.com`,
        provider: 'local',
      });

      // Create a task without organizationId
      orphanTask = await Task.create({
        title: 'Orphan task',
        description: 'Task without org',
        user: userWithoutOrganization._id,
      });
    });

    afterEach(async () => {
      // Clean up all test data
      const userIds = [userWithoutOrganization?._id, userWithOrganization?._id].filter(Boolean);
      await Membership.deleteMany({ userId: { $in: userIds } });
      await Organization.deleteMany({ createdBy: { $in: userIds } });
      await Task.deleteMany({ user: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    });

    it('should create an organization for a user without a membership', async () => {
      await up();

      const memberships = await Membership.find({ userId: userWithoutOrganization._id });
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe('owner');

      const organization = await Organization.findById(memberships[0].organizationId);
      expect(organization).toBeDefined();
      expect(organization.name).toBe("Orphan's organization");
      expect(organization.createdBy.toString()).toBe(userWithoutOrganization._id.toString());
    });

    it('should skip users who already have a membership', async () => {
      await up();

      // The existing user should still have exactly one membership
      const memberships = await Membership.find({ userId: userWithOrganization._id });
      expect(memberships).toHaveLength(1);
      expect(memberships[0].organizationId.toString()).toBe(existingOrganization._id.toString());
    });

    it('should backfill organizationId on tasks without one', async () => {
      await up();

      const updatedTask = await Task.findById(orphanTask._id);
      expect(updatedTask.organizationId).toBeDefined();

      // The task should be assigned to the orphan user's new organization
      const membership = await Membership.findOne({
        userId: userWithoutOrganization._id,
        role: 'owner',
      });
      expect(updatedTask.organizationId.toString()).toBe(membership.organizationId.toString());
    });

    it('should be idempotent — running twice does not duplicate data', async () => {
      await up();
      await up();

      const memberships = await Membership.find({ userId: userWithoutOrganization._id });
      expect(memberships).toHaveLength(1);

      const organizations = await Organization.find({ createdBy: userWithoutOrganization._id });
      expect(organizations).toHaveLength(1);
    });
  });

  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
