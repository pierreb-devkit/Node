/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

const optionalStripeId = z
  .string()
  .trim()
  .optional()
  .transform((val) => (val === '' ? undefined : val));

const plans = ['free', 'starter', 'pro'];
const statuses = ['active', 'past_due', 'canceled', 'trialing', 'incomplete'];

const baseShape = {
  organization: z.string().trim().regex(objectIdRegex, 'organization must be a valid ObjectId'),
  stripeCustomerId: optionalStripeId,
  stripeSubscriptionId: optionalStripeId,
  currentPeriodEnd: z.coerce.date().nullable().optional(),
};

const Subscription = z.object({
  ...baseShape,
  plan: z.enum(plans).default('free'),
  status: z.enum(statuses).default('active'),
  cancelAtPeriodEnd: z.boolean().default(false),
});

/**
 * Update schema without defaults to avoid populating unspecified fields during PATCH
 */
const SubscriptionCore = z.object({
  ...baseShape,
  plan: z.enum(plans),
  status: z.enum(statuses),
  cancelAtPeriodEnd: z.boolean(),
});

const SubscriptionUpdate = SubscriptionCore.partial();

export default {
  Subscription,
  SubscriptionUpdate,
};
