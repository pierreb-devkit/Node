/**
 * Billing pricing constants — devkit-shipped export contract with safe defaults.
 *
 * Downstreams override the VALUES (not the contract) by setting `billing.pricing.*`
 * in their `config/defaults/<project>.config.js`. The global `config` exposes the
 * merged result at `config.billing.pricing`. Importers should always read through
 * `config.billing.pricing.PLAN_QUOTAS` etc., NOT from this file directly — that
 * way downstream values win the glob-merge.
 *
 * Why ship from devkit:
 * - Every downstream running billing wants the same export shape.
 * - Migrations + contract tests + costs service all benefit from a single import path.
 * - Trawl had this file at `modules/billing/config/billing.pricing.constants.js` with
 *   6+ importers — promoted upstream in plan `2026-06-02-trawl-billing-residual-cleanup.md`.
 *
 * @module billing.pricing.constants
 */

/** @type {string} YYYY.MM pricing version (e.g. '2026.05'). Default 0.0.0 = unset. */
export const PRICING_VERSION = '0.0.0';

/** @type {Record<string, number>} Weekly meter quota in compute units per plan. */
export const PLAN_QUOTAS = { free: 0 };

/** @type {Record<string, number>} Compute unit multipliers per feature key. */
export const RATIOS = {};

/** @type {Record<string, { monthly: number, annual: number }>} Stripe price cents per plan. */
export const STRIPE_PRICE_CENTS = {};

/** @type {Record<string, number>} Stripe price cents per extras pack. */
export const STRIPE_PACK_CENTS = {};
