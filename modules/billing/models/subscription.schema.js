/**
 * Module dependencies
 */
import { z } from 'zod';

import config from '../../../config/index.js';

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
  plan: z.enum(config.billing.plans).default('free'),
  status: z.enum(config.billing.statuses).default('active'),
  currentPeriodEnd: z.coerce.date().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
});

const SubscriptionUpdate = Subscription.partial();

export default {
  Subscription,
  SubscriptionUpdate,
};
