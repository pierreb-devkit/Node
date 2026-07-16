/**
 * Migration: Backfill the one-shot signupGrant to plan orgs created without it.
 *
 * The signupGrant was historically credited only on the invite/verify
 * org-creation path (organizations.service.js::createOrganizationForUser). The
 * generic path behind POST /api/organizations (organizations.crud.service.js)
 * never credited it, so orgs created that way — e.g. via a manual "create
 * workspace" screen — started at 0 balance. The code gap is fixed alongside
 * this migration; this repairs already-affected orgs.
 *
 * Delegates to BillingSignupGrantService.grantOnSignup per org so it goes
 * through the EXACT runtime grant path rather than re-implementing the ledger
 * write. That reuse is deliberate — it inherits, for free and consistently:
 *   - ObjectId casting: the repository writes via the Mongoose model, whose
 *     `organization` field is Schema.ObjectId, so the string orgId is cast to a
 *     real ObjectId (a raw-driver write keyed on a string would create orphan,
 *     app-invisible documents that never match existing ones).
 *   - the plan-definition co-presence guard (BillingPlanService.getActivePlan
 *     refuses a signupGrant configured without oneShot).
 *   - Zod amount validation (creditGrant → ExtraBalanceCreditGrant.parse).
 *   - idempotency via the synthetic refId `signup_grant-<orgId>`, so an org
 *     already credited (at signup, by the earlier 20260511 backfill, or by a
 *     prior run of this one) is a no-op.
 *
 * Config-driven: only orgs on a plan that defines a positive signupGrant are
 * touched; a project that configures none is a no-op. This generalises the
 * earlier 20260511 backfill, which hardcoded 500 and enumerated the
 * `subscriptions` collection (missing free orgs with no subscription document);
 * this one enumerates the `organizations` collection.
 *
 * Safe to run while the app is live: each grant is a single-document atomic
 * ledger push and the migration runner serialises execution via a DB-level claim.
 */
import mongoose from 'mongoose';
import config from '../../../config/index.js';
import BillingSignupGrantService from '../services/billing.signupGrant.service.js';
import BillingPlanService from '../services/billing.plan.service.js';

/**
 * @returns {Promise<void>}
 */
export async function up() {
  // Plans that define a positive signupGrant — the only orgs worth scanning.
  const grantPlanIds = (config?.billing?.planDefinitions ?? [])
    .filter((def) => def?.planId && typeof def.signupGrant === 'number' && def.signupGrant > 0)
    .map((def) => def.planId);

  if (grantPlanIds.length === 0) {
    console.info('[migration] backfill-signup-grant: no plan defines a signupGrant — nothing to do');
    return;
  }

  const organizations = mongoose.connection.db.collection('organizations');
  const cursor = organizations.find(
    { plan: { $in: grantPlanIds } },
    { projection: { _id: 1, plan: 1 } },
  );

  let granted = 0;
  let skipped = 0;
  let failedPlanNotFound = 0;
  let failedGuardStripped = 0;
  let failedError = 0;

  for await (const org of cursor) {
    // grantOnSignup swallows ALL failure modes to a bare `null` by design
    // (best-effort — never throws), so plan-not-found, co-presence-guard-stripped,
    // and a genuine runtime error are otherwise indistinguishable from the outside.
    // Pre-classify with the same read-only, config-static lookup grantOnSignup uses
    // internally BEFORE calling it, purely for the completion-log breakdown below —
    // this never short-circuits or skips the real call, so behavior is unchanged.
    const plan = BillingPlanService.getActivePlan(org.plan);
    let preclassifiedFailure = null;
    if (!plan) preclassifiedFailure = 'planNotFound';
    else if (!plan.signupGrant) preclassifiedFailure = 'guardStripped';

    // grantOnSignup is idempotent (refId) and never throws — reuses the runtime
    // path so ObjectId casting + validation + co-presence guard all apply.
    const result = await BillingSignupGrantService.grantOnSignup({
      orgId: org._id.toString(),
      planId: org.plan,
    });

    if (result == null) {
      if (preclassifiedFailure === 'planNotFound') failedPlanNotFound += 1;
      else if (preclassifiedFailure === 'guardStripped') failedGuardStripped += 1;
      // Plan found + grant configured, yet still null: the repository call itself
      // threw and grantOnSignup's catch swallowed it — a genuine runtime error.
      else failedError += 1;
    } else if (result.applied === false) {
      // Idempotent no-op — org already had a signup_grant entry.
      skipped += 1;
    } else {
      granted += 1;
    }
  }

  const failed = failedPlanNotFound + failedGuardStripped + failedError;
  console.info(
    `[migration] backfill-signup-grant: complete — granted=${granted} skipped=${skipped} failed=${failed} `
    + `(planNotFound=${failedPlanNotFound} guardStripped=${failedGuardStripped} error=${failedError})`,
  );
}

/**
 * Reverse: intentional no-op.
 *
 * This migration shares the `signup_grant` refId scheme with the app's runtime
 * grant and the earlier 20260511 backfill, so signup_grant ledger entries cannot
 * be attributed to this migration specifically. A blanket removal would revert
 * legitimately-earned grants too. Reverting is left to a manual, audited
 * operation if ever required.
 *
 * @returns {Promise<void>}
 */
export async function down() {
  console.warn('[migration] backfill-signup-grant DOWN: intentional no-op — signup_grant entries are not attributable to this migration; revert manually if required.');
}
