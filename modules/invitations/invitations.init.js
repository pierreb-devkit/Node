/**
 * Module dependencies
 */
import { registerSignupEligibility } from '../auth/services/auth.eligibility.js';
import InvitationsService from './services/invitations.service.js';
import invitationEvents from './lib/events.js';
import logger from '../../lib/services/logger.js';
import config from '../../config/index.js';

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
    // Whether THIS checker atomically claimed the invite (local path only — OAuth never
    // claims, see below). Relayed back as `claimed` (#3981) so auth.controller gates
    // finalize/release on the checker's own answer instead of re-deriving the same
    // closed-signup / userFacing condition a second time from config: this module is the
    // ONLY code that calls `claim()`, so it is the single source of truth for whether a
    // finalize/release is meaningful — duplicating the condition on the auth side would
    // risk drifting out of lockstep and either finalizing an invite that was never
    // claimed (`InvitationRepository.finalize` does not require `consumingAt`, so it
    // would silently accept an unclaimed token) or leaving a claimed one stuck.
    let claimed = false;
    if (ctx.oauth) {
      // E7: honor an OAuth invite only when the provider verified the email.
      if (ctx.oauth.emailVerifiedByProvider) {
        invite = await InvitationsService.assertInvitedByEmail({ email: ctx.email });
      }
      // OAuth has no token to claim; the consumingAt exclusion on findValidByEmail
      // already hides a claimed-but-unfinalized invite. No two-phase claim here —
      // `claimed` stays false, but auth's OAuth controller path (checkOAuthUserProfile)
      // finalizes unconditionally on a resolved OAuth invite regardless (unaffected by
      // #3981 — OAuth's eligibility check only ever runs under closed signup today).
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
      if (invite && !ctx.signupOpen) {
        // E2: closed signup — the invite is REQUIRED to open the gate, so atomically
        // CLAIM it BEFORE the user is created. A replay / concurrent accept races here
        // and loses: claim() throws AppError(422), which propagates out of this checker
        // and blocks signup entirely — correct here, because without the invite this
        // signup was never eligible in the first place (the throw IS the eligibility
        // decision on this path).
        await InvitationsService.claim(token); // throws AppError(422) if not claimable
        claimed = true;
      } else if (invite && config.invitations?.userFacing) {
        // #3981: public signup is OPEN, but userFacing opts a deployment INTO honoring a
        // presented token anyway (the open-signup hole documented in this module's
        // README point 3 — a presented token used to resolve but never claim/finalize
        // while signup was open, so the referral loop could never convert on open-signup
        // deployments). CRITICAL DIFFERENCE from the closed-signup branch above: the
        // invite is a BONUS here, never required — open signup's own invariant is that a
        // presented token must NEVER be able to block or fail an otherwise-valid signup.
        // So a lost claim race (two near-simultaneous submits of the same invite link —
        // plausible: a double-click or a client retry) must NOT propagate; it must
        // downgrade to "unclaimed" and let signup proceed as if the token had merely been
        // presented-but-not-required (pre-#3981 behavior for this exact case). `invite`
        // stays resolved (harmless — the email-pin downstream is already a no-op, since
        // assertInvited required the submitted email to match it), but `claimed` stays
        // false, so auth.controller's `eligibility.claimed` gate correctly skips
        // finalize/release for a token this checker never actually got to burn.
        try {
          await InvitationsService.claim(token);
          claimed = true;
        } catch (claimErr) {
          logger.warn('[invitations] userFacing open-signup claim lost a race or the invite was already consumed — proceeding as a plain (unattributed) signup', {
            message: claimErr?.message,
          });
        }
      }
      // Outside both branches (open signup, userFacing off) the token is presented but
      // not required, so we resolve WITHOUT claiming: `claimed` stays false, so auth
      // won't finalize it either — claiming would only lock the token mid-claim for no
      // reason (preserves the original P2 gating). assertInvited already enforced the
      // email pin (E5); the claim filters token+pending+unclaimed+unexpired.
    }
    if (!invite) return undefined;
    // Return the resolved (+claimed, local) invite plus `claimed` + finalize/release
    // closures bound to it. The accept/release logic stays in this module; auth just
    // relays. P8a: `finalize` now routes through InvitationsService.accept, which
    // finalizes the invite AND wires the referral substrate (#3842) — stamps
    // referredBy on the new user (server-side) + emits `invitation.accepted`. The
    // closure name stays `finalize` so auth.controller relays it unchanged (auth
    // never imports us); accept is a superset of finalize. Fires on BOTH the token
    // AND the OAuth path (both go through this same closure), so OAuth-invited users
    // are credited too.

    /**
     * @desc Finalize accepted invite and run referral side-effects (P8a).
     * Delegates to InvitationsService.accept so auth stays import-free.
     * @param {String} userId - the just-created user id
     * @returns {Promise<Object|null>} finalized invitation document, or null if not finalized
     */
    const finalizeInvite = (userId) => InvitationsService.accept(invite, userId);

    return {
      invite,
      claimed,
      finalize: finalizeInvite,
      release: () => InvitationsService.release(invite.id),
    };
  });

  // Mandatory: an unhandled 'error' emit would crash the process (mirrors billing.init.js).
  // Registered here (after config is ready) so events.js stays config-free / import-safe.
  invitationEvents.on('error', (err) => logger.error('[invitationEvents] uncaught error', { err }));
};
