/**
 * Module dependencies
 */
import { z } from 'zod';
import config from '../../../config/index.js';

/**
 *  Data Schema
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

const optionalStripeId = z
  .string()
  .trim()
  .optional()
  .transform((val) => (val === '' ? undefined : val));

const baseShape = {
  organization: z.string().trim().regex(objectIdRegex, 'organization must be a valid ObjectId'),
  stripeCustomerId: optionalStripeId,
  stripeSubscriptionId: optionalStripeId,
  currentPeriodEnd: z.coerce.date().nullable().optional(),
  // ── Compute fields (optional — backward-compatible) ──────────────────────
  planVersion: z.string().trim().optional(),
  currentPeriodStart: z.coerce.date().nullable().optional(),
  pastDueSince: z.coerce.date().nullable().optional(),
};

const Subscription = z.object({
  ...baseShape,
  plan: z.enum(config.billing.plans).default('free'),
  status: z.enum(config.billing.statuses).default('active'),
  cancelAtPeriodEnd: z.boolean().default(false),
});

/**
 * Update schema without defaults to avoid populating unspecified fields during PATCH
 */
const SubscriptionCore = z.object({
  ...baseShape,
  plan: z.enum(config.billing.plans),
  status: z.enum(config.billing.statuses),
  cancelAtPeriodEnd: z.boolean(),
});

const SubscriptionUpdate = SubscriptionCore.partial();

/**
 * Checkout request body schema
 */
const CheckoutRequest = z
  .object({
    priceId: z.string().trim().min(1, 'priceId is required'),
    successUrl: z.string().url('successUrl must be a valid URL'),
    cancelUrl: z.string().url('cancelUrl must be a valid URL'),
  })
  .strict();

/**
 * Portal request body schema
 */
const PortalRequest = z
  .object({
    returnUrl: z.string().url('returnUrl must be a valid URL').optional(),
  })
  .strict();

export default {
  Subscription,
  SubscriptionUpdate,
  CheckoutRequest,
  PortalRequest,
};
