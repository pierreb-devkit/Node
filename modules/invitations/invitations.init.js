/**
 * Module dependencies
 */
import { registerSignupEligibility } from '../auth/services/auth.eligibility.js';
import InvitationsService from './services/invitations.service.js';
import invitationEvents from './lib/events.js';
import logger from '../../lib/services/logger.js';

/**
 * Invitations module initialisation.
 *
 * Plugs the platform-invite gate into auth via the generic eligibility registry
 * (invitations → auth; auth never imports us). The checker RESOLVES + atomically
 * CLAIMS the invite that opens the closed-signup gate and RETURNS
 * `{ invite, finalize, release }` — auth relays that result back so the signup
 * controller can canonicalize the account email and, on the way out, finalize the
 * invite (full success) or release it (any failure), without importing any
 * invitation code (the dependency inversion).
 *
 * Two-phase claim (E2): the CLAIM happens here (inside the eligibility check, before
 * the user is created) so a replay / double-accept races on the atomic stamp and
 * loses (throws 422). The invite is only burned (usedAt + status:'accepted') by the
 * `finalize` closure once signup fully succeeds; `release` clears the claim so a
 * later-step failure does not permanently burn the token.
 *
 * @returns {Promise<void>}
 */
export default async () => {
  // E2 boot-time stale-claim sweep: release any invite left mid-claim by a crash in
  // a prior process (consumingAt older than the staleness window, never finalized).
  // Best-effort (the service swallows + logs errors) so a sweep failure never blocks
  // boot. The read paths (findValid/findValidByEmail) also sweep lazily — this is the
  // belt to their suspenders, since the stack has NO in-process scheduler/cron.
  await InvitationsService.sweepStaleClaims();

  // Plug the platform-invite gate into auth (invitations → auth; auth never imports us).
  // One checker covers both signup methods, discriminated by ctx.oauth:
  //   - local signup: invite resolved by the `?inviteToken=` query (email-pinned),
  //     then atomically CLAIMED (the replay guard).
  //   - OAuth signup: no token rides the redirect, so the invite is matched on the
  //     provider-verified email — and ONLY when the provider vouches for it (E7).
  //     No token to claim; the consumingAt exclusion on the email lookup is the guard.
  // The throw decision (closed-signup AND no invite ⇒ block) stays in auth.controller
  // (cap + sign.up gate). We RESOLVE the invite, CLAIM it (local), and return it paired
  // with `finalize`/`release` closures (the return-value seam); auth hands that result
  // back to whoever opened the gate so it can pin the account email + finalize/release
  // the invite without importing any invitation code (the dependency inversion).
  // Returns undefined (no result) when no eligible invite — auth then sees null.
  registerSignupEligibility(async (ctx = {}) => {
    let invite = null;
    if (ctx.oauth) {
      // E7: honor an OAuth invite only when the provider verified the email.
      if (ctx.oauth.emailVerifiedByProvider) {
        invite = await InvitationsService.assertInvitedByEmail({ email: ctx.email });
      }
      // OAuth has no token to claim; the consumingAt exclusion on findValidByEmail
      // already hides a claimed-but-unfinalized invite. No two-phase claim here.
    } else {
      const carrier = ctx.req;
      if (!carrier) return undefined;
      // E13: Vue sends the token as `?inviteToken=` (query), NOT in the body — query is
      // the real source. On the standard HTTP signup path the model middleware strips
      // unknown body keys (incl. `inviteToken`) before this checker runs, so the body
      // fallback below only ever fires for non-HTTP / direct callers (and future-proofs
      // if the signup Zod schema ever whitelists the field). Read query first.
      const token = carrier.query?.inviteToken ?? carrier.body?.inviteToken;
      // E5: "no email supplied with a token ⇒ no eligibility" lives in assertInvited.
      invite = await InvitationsService.assertInvited({ token, email: ctx.email });
      // E2: atomically CLAIM the resolved invite BEFORE the user is created — BUT ONLY
      // when the invite is REQUIRED to open the gate (closed signup). When public
      // signup is open the token is presented but not required, so we resolve WITHOUT
      // claiming: auth won't finalize it either (it gates finalize behind !sign.up), so
      // claiming would only lock the token mid-claim for no reason (preserves P2 gating).
      // A replay / concurrent accept on the closed-signup path races here and loses
      // (claim throws 422). assertInvited already enforced the email pin (E5); the claim
      // filters token+pending+unclaimed.
      if (invite && !ctx.signupOpen) {
        await InvitationsService.claim(token); // throws AppError(422) if not claimable
      }
    }
    if (!invite) return undefined;
    // Return the resolved (+claimed, local) invite plus finalize/release closures
    // bound to it. The accept/release logic stays in this module; auth just relays.
    // P8a: `finalize` now routes through InvitationsService.accept, which finalizes
    // the invite AND wires the referral substrate (#5) — stamps referredBy on the new
    // user (server-side) + emits `invitation.accepted`. The closure name stays
    // `finalize` so auth.controller relays it unchanged (auth never imports us); accept
    // is a superset of finalize. Fires on BOTH the token AND the OAuth path (both go
    // through this same closure), so OAuth-invited users are credited too.
    return {
      invite,
      finalize: (userId) => InvitationsService.accept(invite, userId),
      release: () => InvitationsService.release(invite.id),
    };
  });

  // Mandatory: an unhandled 'error' emit would crash the process (mirrors billing.init.js).
  // Registered here (after config is ready) so events.js stays config-free / import-safe.
  invitationEvents.on('error', (err) => logger.error('[invitationEvents] uncaught error', { err }));
};
