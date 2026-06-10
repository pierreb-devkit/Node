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
 * (invitations → auth; auth never imports us). The checker RESOLVES the invite
 * that opens the closed-signup gate and RETURNS `{ invite, consume }` — auth
 * relays that result back so the signup controller can canonicalize the account
 * email + consume the invite, without importing any invitation code (the
 * dependency inversion). The `consume` closure keeps the consume logic owned by
 * this module.
 *
 * @returns {Promise<void>}
 */
export default async () => {
  // Plug the platform-invite gate into auth (invitations → auth; auth never imports us).
  // One checker covers both signup methods, discriminated by ctx.oauth:
  //   - local signup: invite resolved by the `?inviteToken=` query (email-pinned).
  //   - OAuth signup: no token rides the redirect, so the invite is matched on the
  //     provider-verified email — and ONLY when the provider vouches for it (E7).
  // The throw decision (closed-signup AND no invite ⇒ block) stays in auth.controller
  // (cap + sign.up gate). We RESOLVE the invite and return it paired with a bound
  // single-use `consume` closure (the return-value seam); auth hands that result
  // back to whoever opened the gate so it can pin the account email + burn the
  // invite without importing any invitation code (the dependency inversion).
  // Returns undefined (no result) when no eligible invite — auth then sees null.
  registerSignupEligibility(async (ctx = {}) => {
    let invite = null;
    if (ctx.oauth) {
      // E7: honor an OAuth invite only when the provider verified the email.
      if (ctx.oauth.emailVerifiedByProvider) {
        invite = await InvitationsService.assertInvitedByEmail({ email: ctx.email });
      }
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
    }
    if (!invite) return undefined;
    // Return the resolved invite + a single-use consume closure bound to its id.
    // consume logic stays in this module; auth just relays the result.
    return { invite, consume: () => InvitationsService.consume(invite.id) };
  });

  // Mandatory: an unhandled 'error' emit would crash the process (mirrors billing.init.js).
  // Registered here (after config is ready) so events.js stays config-free / import-safe.
  invitationEvents.on('error', (err) => logger.error('[invitationEvents] uncaught error', { err }));
};
