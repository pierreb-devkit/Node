/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import { generateOrganizationSlug } from '../helpers/organizations.slug.js';

/**
 * Migration: Create default organizations for existing users.
 * For each user without a membership, creates a personal organization
 * and an owner membership. Also backfills organizationId on tasks
 * and uploads that are missing one.
 *
 * This migration is idempotent: users who already have a membership are
 * skipped, and tasks that already have an organizationId are not touched.
 * @returns {Promise<void>} Resolves when all records have been created/updated.
 */
export async function up() {
  const User = mongoose.model('User');
  const Organization = mongoose.model('Organization');
  const Membership = mongoose.model('Membership');

  // ── Step 1: Find users who don't have any membership yet ──────────
  const allMemberships = await Membership.find({}, 'userId').lean();
  const usersWithOrganization = new Set(allMemberships.map((m) => m.userId.toString()));
  const usersWithoutOrganization = await User.find({
    _id: { $nin: [...usersWithOrganization] },
  }).lean();

  // ── Step 2: Create a default organization + owner membership per user
  // Uses a session/transaction to prevent duplicate or orphaned orgs on retry
  for (const user of usersWithoutOrganization) {
    // Double-check: skip if a membership was created since the initial query
    const alreadyHas = await Membership.findOne({ userId: user._id }).lean();
    if (alreadyHas) continue;

    const firstName = user.firstName || 'User';
    const lastName = user.lastName || '';

    const slug = await generateOrganizationSlug(firstName, lastName);

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const [organization] = await Organization.create(
          [{ name: `${firstName}'s organization`, slug, createdBy: user._id }],
          { session },
        );

        await Membership.create(
          [{ userId: user._id, organizationId: organization._id, role: 'owner' }],
          { session },
        );

        await User.updateOne({ _id: user._id }, { currentOrganization: organization._id }, { session });
      });
    } finally {
      await session.endSession();
    }
  }

  // ── Step 2b: Backfill currentOrganization for users who have a membership but no currentOrganization
  const usersWithoutCurrentOrg = await User.find({
    $or: [{ currentOrganization: { $exists: false } }, { currentOrganization: null }],
  }).lean();

  for (const user of usersWithoutCurrentOrg) {
    const membership = await Membership.findOne({ userId: user._id }).lean();
    if (membership) {
      await User.updateOne({ _id: user._id }, { currentOrganization: membership.organizationId });
    }
  }

  // ── Step 3: Backfill organizationId on tasks without one ──────────
  let Task;
  try {
    Task = mongoose.model('Task');
  } catch {
    // Task model not registered — skip task backfill only
    Task = null;
  }

  if (Task) {
    const tasksWithoutOrganization = await Task.find({
      $or: [{ organizationId: { $exists: false } }, { organizationId: null }],
    }).lean();

    for (const task of tasksWithoutOrganization) {
      // Look up the user's current org first, fall back to any active membership
      const taskUser = await User.findById(task.user, 'currentOrganization').lean();
      const orgId = taskUser?.currentOrganization
        || (await Membership.findOne({ userId: task.user, status: { $in: ['active', undefined] } }).lean())?.organizationId;
      if (orgId) {
        await Task.updateOne({ _id: task._id }, { organizationId: orgId });
      }
    }
  }

  // ── Step 4: Backfill organizationId on uploads without one ──────────
  let Upload;
  try {
    Upload = mongoose.model('Uploads');
  } catch {
    // Upload model not registered — skip upload backfill only
    Upload = null;
  }

  if (Upload) {
    const uploadsWithoutOrganization = await Upload.find({
      $or: [{ 'metadata.organizationId': { $exists: false } }, { 'metadata.organizationId': null }],
    }).lean();

    for (const upload of uploadsWithoutOrganization) {
      if (!upload.metadata?.user) continue;
      // Look up the user's current org first, fall back to any active membership
      const uploadUser = await User.findById(upload.metadata.user, 'currentOrganization').lean();
      const orgId = uploadUser?.currentOrganization
        || (await Membership.findOne({ userId: upload.metadata.user, status: { $in: ['active', undefined] } }).lean())?.organizationId;
      if (orgId) {
        await Upload.updateOne({ _id: upload._id }, { 'metadata.organizationId': orgId });
      }
    }
  }
}
