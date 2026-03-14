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
  for (const user of usersWithoutOrganization) {
    const firstName = user.firstName || 'User';
    const lastName = user.lastName || '';

    const slug = await generateOrganizationSlug(firstName, lastName);

    const organization = await Organization.create({
      name: `${firstName}'s organization`,
      slug,
      createdBy: user._id,
    });

    await Membership.create({
      userId: user._id,
      organizationId: organization._id,
      role: 'owner',
    });

    await User.updateOne({ _id: user._id }, { currentOrganization: organization._id });
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
      const membership = await Membership.findOne({ userId: task.user, role: 'owner' }).lean();
      if (membership) {
        await Task.updateOne({ _id: task._id }, { organizationId: membership.organizationId });
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
      const membership = await Membership.findOne({ userId: upload.metadata.user, role: 'owner' }).lean();
      if (membership) {
        await Upload.updateOne({ _id: upload._id }, { 'metadata.organizationId': membership.organizationId });
      }
    }
  }
}
