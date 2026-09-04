const config = {
  audit: {
    routeTypeMap: {
      billing: 'Organization',
    },
  },
  billing: {
    enabled: true,
    // Quotas — downstream projects override these per plan:
    // quotas: {
    //   free:    { documents: { create: 10, export: 50 } },
    //   starter: { documents: { create: 100, export: 500 } },
    //   pro:     { documents: { create: Infinity, export: Infinity } },
    // },
    // Stripe subscription statuses — see https://docs.stripe.com/api/subscriptions/object#subscription_object-status
    statuses: [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ],
    /**
     * Feature flag — default OFF.
     * Set to true in downstream project config to enable meter-based pricing.
     * When false, all meter code paths are no-ops; legacy behavior unchanged.
     */
    meterMode: false,
    /**
     * Default plan used when an organization has no subscription. Configurable per project.
     */
    defaultPlan: 'free',
    /**
     * URL the front-end should redirect users to when quota is exhausted or past_due.
     * Used by middleware error responses (METER_EXHAUSTED, QUOTA_EXCEEDED).
     * Capped at 200 chars in production (lib/helpers/responses.js#MAX_DETAIL_VALUE_LENGTH) —
     * a longer absolute URL is silently dropped from the production response there,
     * even though dev/test still show it via the raw-error blob.
     */
    upgradeUrl: '/billing/plans',
    /**
     * Display-only capacity equivalences for the nav compute gauge
     * (Vue billing.navComputeGauge.component). Each entry maps an operation "kind"
     * to its unit cost; the gauge renders `floor(remaining / unitCost)` as a
     * human-readable "N easy / M heavy operations remaining" estimate. Served
     * verbatim to the client via the auth config (serverConfig.billing.equivalences).
     * Only surfaces while `meterMode` is on (the gauge is hidden otherwise).
     *
     * DEVKIT DEMO VALUES — illustrative, like the other billing defaults in this file.
     * DOWNSTREAM-OVERRIDE: set your own kinds / labels / unit costs, or set
     * `equivalences: []` (or `null`) to show raw units only. Because this ships as
     * the billing base config, simply omitting the key downstream inherits these
     * demo values — disable the chips explicitly with `[]` / `null`.
     *
     * Entry shape: { kind: 'easy' | 'hard', unitCost: number > 0, label: string }
     */
    equivalences: [
      { kind: 'easy', unitCost: 200, label: 'easy operations' },
      { kind: 'hard', unitCost: 2000, label: 'heavy operations' },
    ],
    /**
     * When true, mounts attachUsageContext on protected /api/billing/* routes.
     * Emits X-Meter-Remaining on billing responses. Off by default to avoid
     * extra DB reads on routes that do not need the header.
     */
    attachUsageHeader: false,
    /**
     * Plan definitions — DOWNSTREAM-OVERRIDE-REQUIRED for meter mode.
     * Used by BillingPlanService.ensureSeeded() at boot to upsert BillingPlan docs.
     * Array of objects: { planId, meterQuota: units/week, ratios: { featureKey: multiplier }, version?, signupGrant?, oneShot? }.
     * billing.plans enum is derived at boot from planDefinitions.map(p => p.planId) — do NOT
     * declare billing.plans manually. This is the single source of truth for plan identifiers.
     *
     * version: optional — falls back to billing.meter.ratioVersion, then v${count + 1}.
     * Downstream projects that use YYYY.MM versioning should set this (or set ratioVersion).
     */
    planDefinitions: [
      /**
       * signupGrant: one-time credit given to fresh orgs at signup (N2 feature).
       * oneShot: true = grant does not renew on weekly/monthly reset.
       * DOWNSTREAM-OVERRIDE: set meterQuota + signupGrant per project's actual unit economics.
       */
      { planId: 'free', meterQuota: 0, signupGrant: 500, oneShot: true, ratios: { default: 1 } },
      { planId: 'starter', meterQuota: 50000, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
      { planId: 'enterprise', meterQuota: 2000000, ratios: { default: 1 } },
    ],
    /**
     * Meter unit parameters — downstream projects must override with their
     * actual unit economics before enabling meterMode in production.
     *
     * runBase: flat units charged per run when no cost data is available.
     * runBaseUnits: deprecated alias kept for downstream backward compatibility.
     * maxUnitsPerOperation: safety cap per single operation run.
     */
    meter: {
      runBase: 1,
      runBaseUnits: 1,
      fallbackPlanId: null,
      /**
       * Canonical version string emitted by billing.meter.service attribute() when writing
       * history.planVersion. Downstream projects MUST override this value and keep it
       * aligned with:
       *   1. planDefinitions[].version (or omit it and rely on this value as the fallback)
       *   2. The version string their cost-config writes into history records
       *
       * Preferred format: YYYY.MM (calendar-style, e.g. '2026.05').
       * Legacy format v${N} (e.g. 'v1') is still supported for backward compat,
       * but new projects should use YYYY.MM from the start.
       *
       * A mismatch here causes getPlanByVersion() to return null → ratio=1 fallback +
       * a WARN log in unitsFromCosts. Check that warn at boot if meter charges look flat.
       *
       * DOWNSTREAM-OVERRIDE-REQUIRED — this devkit default is illustrative.
       */
      ratioVersion: '2026.05',
      /**
       * Conversion ratio: 1 unit = 1 / dollarsToUnitRatio USD of underlying cost.
       *
       * DOWNSTREAM-OVERRIDE-REQUIRED — the devkit default (1000) is illustrative.
       * Each downstream project must set this based on their unit economics
       * (cost-target × margin multiplier). Setting this wrong directly affects
       * gross margin: a value of N means each $1 of cost consumes N units, so
       * lowering N halves the margin coverage.
       */
      dollarsToUnitRatio: 1000,
      maxUnitsPerOperation: 10000,
    },
    crons: {
      jitterMaxMs: 60_000,
    },
    planChange: {
      preserveUsageDefault: true,
    },
    alerts: {
      thresholdPercents: [80, 100],
    },
    events: {
      extrasExhausted: 'billing.extras_debit.exhausted',
    },
    /**
     * Extra meter packs — downstream projects override with actual packs.
     * Example: [{ packId: 'pack_500k', meterUnits: 500000, stripePriceId: 'price_xxx' }]
     */
    packs: [],
    /**
     * Referral grant (#3842) — stack default: OFF. The `invitation.accepted` listener
     * in billing.init.js credits meter units to the referrer's and/or referee's
     * organization when an invited signup completes. Entirely config-gated: downstream
     * projects NEVER edit billing.init.js — they flip this block in {project}.config.js:
     *   billing: { referral: { enabled: true, referrerUnits: 1000, refereeUnits: 500 } }
     *
     * enabled       — master switch; when false the listener returns immediately (no-op).
     * referrerUnits — units credited to the INVITER's currentOrganization (0 = skip side).
     * refereeUnits  — units credited to the ACCEPTED USER's organization (0 = skip side).
     * expiryDays    — referral credits expire after N days (same expiry mechanism as
     *                 pack.expiryDays — swept by crons/billing.extrasExpiration.js).
     *                 null = never expire.
     *
     * Pair with the reconcile cron (crons/billing.referralReconcile.js): the listener
     * is in-process fire-and-forget (latency); the cron back-fills missed grants (truth).
     *
     * ⚠️ Referral grants require CLOSED signup (sign.up: false). With public signup
     *    open, a presented invite token is resolved but never claimed/finalized (the
     *    "open signup never burns a token" invariant), so `invitation.accepted` never
     *    fires and enabling this block is a silent no-op. The #3833 gates shipped:
     *    role-keyed list scoping + the create() self-invite guard (the grant-side
     *    floor here skips invitedBy === acceptedUserId as the belt).
     */
    referral: {
      enabled: false,
      referrerUnits: 0,
      refereeUnits: 0,
      expiryDays: 365,
    },
  },
  stripe: {
    secretKey: process.env.DEVKIT_NODE_stripe_secretKey ?? '',
    webhookSecret: process.env.DEVKIT_NODE_stripe_webhookSecret ?? '',
    /**
     * Feature flag — default OFF.
     * Set to true in downstream project config once Stripe Tax product is enabled
     * in the Stripe Dashboard. In LIVE mode, Stripe rejects automatic_tax: enabled
     * if the Tax product is not activated → checkout sessions will fail.
     * See: https://stripe.com/docs/tax/set-up
     *
     * V1 intent: disabled (auto-entrepreneur FR, franchise TVA art. 293 B).
     */
    automaticTax: false,
    prices: {
      starter: {
        monthly: process.env.DEVKIT_NODE_stripe_prices_starter_monthly ?? '',
        annual: process.env.DEVKIT_NODE_stripe_prices_starter_annual ?? '',
      },
      pro: {
        monthly: process.env.DEVKIT_NODE_stripe_prices_pro_monthly ?? '',
        annual: process.env.DEVKIT_NODE_stripe_prices_pro_annual ?? '',
      },
      /**
       * Extra packs price map — downstream project override.
       * Example: { pack_500k: 'price_xxx', pack_2m: 'price_yyy' }
       */
      packs: {},
    },
  },
  rateLimit: {
    // Public, unauthenticated /api/billing/plans route that fans out to Stripe on
    // cache miss. Lives in this base layer so the profile is present — and the
    // limiter active — under EVERY env, not only the literal `production`; a missing
    // profile means a no-op limiter (Stripe-API-quota DoS surface). Stricter caps
    // are applied in config/defaults/production.config.js as an override.
    billingPlans: {
      windowMs: 60 * 1000, // 1 min
      max: 300, // lenient in dev; production overrides to a stricter cap
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
