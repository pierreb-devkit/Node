# Authentication

The API uses JWT authentication delivered via an `httpOnly` `TOKEN`
cookie. Clients do not receive the token in the response body — they
receive user metadata and a `tokenExpiresIn` timestamp, and subsequent
requests are authenticated automatically as long as the cookie is sent.

## Sign up

Create a new account by sending a POST request:

```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "email": "user@example.com", "password": "YourPassword1!" }'
```

If email verification is enabled, you will receive a confirmation link.
On success the response sets the `TOKEN` cookie and returns a body like:

```json
{ "user": { "id": "...", "email": "user@example.com" }, "tokenExpiresIn": 1735689600000 }
```

## Log in

Authenticate with your credentials:

```bash
curl -X POST http://localhost:3000/api/auth/signin \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "email": "user@example.com", "password": "YourPassword1!" }'
```

The response sets the `TOKEN` cookie and returns the user, their CASL
abilities, and `tokenExpiresIn` (epoch ms at which the JWT expires).

## Using the token

Send the cookie on every protected request — the JWT is extracted from
the `TOKEN` cookie by the passport strategy:

```bash
curl http://localhost:3000/api/users/me \
  -b cookies.txt
```

Browser clients get this for free: the cookie is `httpOnly`, `Secure`,
and `SameSite`-configured, so it is attached automatically to same-site
requests.

## Token lifetime

The JWT lifetime is controlled server-side by `config.jwt.expiresIn`.
The signin/signup responses expose `tokenExpiresIn` so clients can
proactively re-authenticate before expiry. There is no refresh-token
endpoint — call `/api/auth/signin` again when the token expires.

## Password reset

Request a reset email, then confirm with the token received:

```bash
# Request reset
curl -X POST http://localhost:3000/api/auth/forgot \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com" }'

# Confirm reset
curl -X POST http://localhost:3000/api/auth/reset \
  -H "Content-Type: application/json" \
  -d '{ "token": "<resetToken>", "newPassword": "NewPassword1!" }'
```

## Next steps

- See the **Organizations** guide to create teams and manage roles.
- Browse the endpoint reference for the full list of auth routes.
