/**
 * Module dependencies
 */
import { EventEmitter } from 'events';

/**
 * Singleton emitter for organization events. Config-free / import-safe.
 *
 * Events:
 *   - `organization.created` — emitted (#3952) by BOTH org-creation call sites
 *     (organizations.crud.service.js::create, the generic POST /api/organizations path, AND
 *     organizations.service.js::createOrganizationForUser, the signup path) immediately after
 *     the organization + owner membership are durably created. This is the sanctioned seam for
 *     billing's one-shot signupGrant (billing.init.js), replacing a direct import of
 *     BillingSignupGrantService from organizations — the organizations module must stay
 *     removable without billing. Fire-and-forget; the emit-site try/catch only guards a
 *     SYNCHRONOUS listener throw — see the `organization.provisioned` note below for the
 *     async-rejection caveat, which applies identically here (the listener owns its own guard).
 *     Payload: {
 *       orgId:  String — the freshly created organization's id
 *       planId: String — the plan to evaluate the grant against (both call sites pass 'free' —
 *         the only plan a fresh org can have at creation time)
 *     }
 *   - `organization.provisioned` — emitted (#3844) by OrganizationsService.handleSignupOrganization
 *     on EVERY exit path that returns a real organization: the fresh-create paths AND the A4
 *     idempotent-convergence path (downstream consumers must be idempotent — a converged retry
 *     double-fires by design). Fire-and-forget. With a mailer configured this fires at EMAIL
 *     VERIFICATION (the org is only provisioned then) — exactly the moment an instant referee
 *     referral grant becomes possible.
 *     ⚠️ The try/catch around the `emit` call (handleSignupOrganization) only guards against a
 *     SYNCHRONOUS listener throw — `EventEmitter.emit` is synchronous, so it returns before any
 *     async listener settles. An ASYNC listener that REJECTS escapes the emit-site try/catch as
 *     an unhandledRejection AFTER emit returns. Therefore an async listener (e.g. the #3844
 *     instant referee grant in billing.init.js, which complies) MUST own its own internal
 *     try/catch and never let a rejection escape.
 *     Payload: {
 *       userId:         String — the signing-up (or converging) user's id
 *       organizationId: String — the provisioned (or converged-to) organization's id
 *     }
 *
 * This file ships ONLY the singleton; the mandatory 'error' listener is registered in
 * organizations.init.js after config is ready, so this file stays config-free and
 * importable without ordering hazards (mirrors invitations/lib/events.js).
 */
const organizationEvents = new EventEmitter();

export default organizationEvents;
