/**
 * Module dependencies
 */
import { z } from 'zod';

/**
 * Per-kind product-email opt-out (#4162). Same pattern as `Attribution` in
 * users.schema.js: a fixed-shape, `.strict()` sub-object so an unknown key is
 * REJECTED instead of silently accepted. Both kinds default `true` (opt-OUT
 * model) so an existing user with no `emailPreferences` at all reads as
 * "every kind on" — no migration needed. A write is a WHOLE-OBJECT replace
 * (same semantics `complementary` already has on `users.schema.js`) — a
 * caller that wants to flip one kind without touching the other must send
 * both.
 *
 * Deliberately its OWN file, with no `config` import: `users.schema.js`'s
 * `User` reads `config.whitelists.users.roles` at module-evaluation time, so
 * any module that imports it — even for an unrelated export — inherits that
 * coupling. `users.service.js` needs `EmailKind` at runtime (to validate
 * `sendProductMail`/`announce`/`setEmailPreference`'s `kind` argument) without
 * pulling that whole chain in; `users.schema.js` re-exports both from here so
 * the HTTP-facing `User`/`UserUpdate` schemas keep working unchanged.
 */
const EmailPreferences = z.object({
  onboarding: z.boolean().optional().default(true),
  news: z.boolean().optional().default(true),
}).strict();

/**
 * The product-email kinds `sendProductMail`/`announce` (users.service.js)
 * accept, and the only keys `EmailPreferences` declares — kept side by side
 * so the two can never drift apart.
 */
const EmailKind = z.enum(['onboarding', 'news']);

export { EmailPreferences, EmailKind };
