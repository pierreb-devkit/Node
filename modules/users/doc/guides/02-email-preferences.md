# Email Preferences & Unsubscribe

Every user has an `emailPreferences` setting with two independent switches: `onboarding` and `news`. Both default to **on** — a user who has never touched this setting receives every kind of product email.

This only affects **product email** (an onboarding series, an announcement). Transactional email — password reset, email verification, invitations — always goes through regardless of these switches.

## Updating preferences

Authenticated users can update their own preferences the same way they update the rest of their profile:

```http
PUT /api/users
Authorization: Bearer <token>
Content-Type: application/json

{ "emailPreferences": { "onboarding": true, "news": false } }
```

Send both fields together: this call replaces the whole `emailPreferences` object, so a partial object resets the field you omit back to its default.

## One-click unsubscribe

Every product email sent through `sendProductMail`/`announce` carries a `List-Unsubscribe` header (plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, per RFC 8058). Mail clients that support one-click unsubscribe can turn a kind off with no login and no page — the header points directly at:

```http
POST /api/users/unsubscribe/:token
```

The token is specific to one user and one kind, has no expiry, and can be posted more than once safely (turning the kind off again is a no-op). A request with an invalid or tampered token returns `400`; a successful one returns `200` with the kind that was turned off.

This URL is built from `config.domain` (via `getApiBaseUrl()`) — the stack's one documented public domain, which **must resolve to the API's real public HTTPS origin** — not the frontend origin, and not `config.api.{protocol,host,port}` (the server's own bind settings, used only as a fallback when `config.domain` is empty). It's an API route a mail client POSTs to directly, never a page a browser navigates to; an unset or misconfigured `config.domain` means a broken link in a real mail.

## Email settings link

Every product email also carries a second, human-facing link in `params.emailSettingsUrl` — the frontend's account page (`config.cors.origin` + `config.users.emailSettingsPath`, default `/users/profile`) where a signed-in user can review and change every `emailPreferences` kind, not just the one this particular mail happens to carry. The default footer partial renders it as an "Email settings" link whenever it's present. `params.unsubscribeUrl` (the token URL above) is still passed through for backward compat on any template that renders it directly.
