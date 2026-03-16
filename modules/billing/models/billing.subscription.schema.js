/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 *  Data Schema
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

const Subscription = z.object({
  organization: z
    .string()
    .trim()
    .regex(objectIdRegex, 'organization must be a valid ObjectId'),
  stripeCustomerId: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val === '' ? undefined : val)),
  stripeSubscriptionId: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val === '' ? undefined : val)),
  plan: z.enum(['free', 'starter', 'pro']).default('free'),
  status: z.enum(['active', 'past_due', 'canceled', 'trialing', 'incomplete']).default('active'),
  currentPeriodEnd: z.coerce.date().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
});

/**
 * Update schema without defaults to avoid populating unspecified fields during PATCH
 */
const SubscriptionCore = z.object({
  organization: z
    .string()
    .trim()
    .regex(objectIdRegex, 'organization must be a valid ObjectId'),
  stripeCustomerId: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val === '' ? undefined : val)),
  stripeSubscriptionId: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val === '' ? undefined : val)),
  plan: z.enum(['free', 'starter', 'pro']),
  status: z.enum(['active', 'past_due', 'canceled', 'trialing', 'incomplete']),
  currentPeriodEnd: z.coerce.date().nullable().optional(),
  cancelAtPeriodEnd: z.boolean(),
});

const SubscriptionUpdate = SubscriptionCore.partial();

export default {
  Subscription,
  SubscriptionUpdate,
};
