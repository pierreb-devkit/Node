/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const Subscription = z.object({
  organization: z.string().trim().min(1),
  stripeCustomerId: z.string().trim().optional(),
  stripeSubscriptionId: z.string().trim().optional(),
  plan: z.enum(['free', 'starter', 'pro']).default('free'),
  status: z.enum(['active', 'past_due', 'canceled', 'trialing', 'incomplete']).default('active'),
  currentPeriodEnd: z.coerce.date().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
});

const SubscriptionUpdate = Subscription.partial();

export default {
  Subscription,
  SubscriptionUpdate,
};
