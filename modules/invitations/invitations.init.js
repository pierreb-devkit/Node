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
 * (invitations → auth; auth never imports us). The checker resolves the invite
 * that opens the closed-signup gate and stashes it on `req` so the auth signup
 * controller can canonicalize the account email + consume the invite — without
 * importing any invitation code (the dependency inversion).
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
  // (cap + sign.up gate). We resolve + stash the invite and a bound single-use consume
  // closure on the ctx-carrier (`req` for signup, a synthetic ctx for OAuth) so the
  // controller can pin the account email + burn the invite without importing any
  // invitation code (the dependency inversion).
  registerSignupEligibility(async (ctx = {}) => {
    const carrier = ctx.req;
    if (!carrier) return;
    let invite = null;
    if (ctx.oauth) {
      // E7: honor an OAuth invite only when the provider verified the email.
      if (ctx.oauth.emailVerifiedByProvider) {
        invite = await InvitationsService.assertInvitedByEmail({ email: ctx.email });
      }
    } else {
      // E13: Vue sends the token as `?inviteToken=` (query), NOT in the body. Read query first.
      const token = carrier.query?.inviteToken ?? carrier.body?.inviteToken;
      // E5: "no email supplied with a token ⇒ no eligibility" lives in assertInvited.
      invite = await InvitationsService.assertInvited({ token, email: ctx.email });
    }
    carrier._signupInvite = invite;
    carrier._consumeSignupInvite = invite ? () => InvitationsService.consume(invite.id) : null;
  });

  // Mandatory: an unhandled 'error' emit would crash the process (mirrors billing.init.js).
  // Registered here (after config is ready) so events.js stays config-free / import-safe.
  invitationEvents.on('error', (err) => logger.error('[invitationEvents] uncaught error', { err }));
};
