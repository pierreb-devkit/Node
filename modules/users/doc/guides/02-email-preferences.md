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
