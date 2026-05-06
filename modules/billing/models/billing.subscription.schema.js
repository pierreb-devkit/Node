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
  // ── Meter fields (optional — backward-compatible) ────────────────────────
  planVersion: z.string().trim().optional(),
  currentPeriodStart: z.coerce.date().nullable().optional(),
  pastDueSince: z.coerce.date().nullable().optional(),
  lastResetAt: z.coerce.date().nullable().optional(),
  // Per-family event ordering guards
  lastSubscriptionEventCreatedAt: z.number().int().nullable().optional(),
  lastSubscriptionEventId: z.string().nullable().optional(),
  lastInvoiceEventCreatedAt: z.number().int().nullable().optional(),
  lastInvoiceEventId: z.string().nullable().optional(),
};

const Subscription = z.object({
  ...baseShape,
  plan: z.enum(config.billing.plans).default('free'),
  status: z.enum(config.billing.statuses).default('active'),
});

/**
 * Update schema without defaults to avoid populating unspecified fields during PATCH
 */
const SubscriptionCore = z.object({
  ...baseShape,
  plan: z.enum(config.billing.plans),
  status: z.enum(config.billing.statuses),
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

/**
 * Extras checkout request body schema
 */
const ExtrasCheckoutRequest = z
  .object({
    packId: z.string().trim().min(1, 'packId is required'),
    successUrl: z.string().url('successUrl must be a valid URL'),
    cancelUrl: z.string().url('cancelUrl must be a valid URL'),
    // Caller-provided stable intent ID for idempotency (prevents double-click double-charge).
    // When absent, a soft-stable minute-bucketed key is used as fallback.
    // Max 180 chars: Stripe idempotency key limit is 255; the prefix
    // `extras_checkout_{orgId}_{packId}_` consumes ~64 chars, leaving ~10 chars margin.
    intentId: z.string().min(1).max(180).optional(),
  })
  .strict();

const AdminRefundRequest = z
  .object({
    chargeId: z.string().trim().min(1, 'chargeId is required'),
    amountCents: z.number().int().positive().optional(),
    // Stripe refund reason: https://stripe.com/docs/api/refunds/create#create_refund-reason
    reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
    // Caller-provided stable key for Stripe idempotency (prevents admin double-click double-refund).
    // Required — frontend MUST generate a UUID per click and send it. Without this, two clicks
    // separated by >1 minute could produce two separate Stripe refunds.
    refundRequestId: z.string().min(8).max(128),
  })
  .strict();

const AdminBumpPlanRequest = z
  .object({
    planId: z.string().trim().min(1, 'planId is required'),
    meterQuota: z.number().int().nonnegative(),
    ratios: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .strict();

export {
  AdminRefundRequest,
  AdminBumpPlanRequest,
};

export default {
  Subscription,
  SubscriptionUpdate,
  CheckoutRequest,
  PortalRequest,
  ExtrasCheckoutRequest,
  AdminRefundRequest,
  AdminBumpPlanRequest,
};
