# Authentication

The API uses JWT-based authentication with access and refresh tokens.

## Sign up

Create a new account by sending a POST request:

```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com", "password": "YourPassword1!" }'
```

If email verification is enabled, you will receive a confirmation link.

## Log in

Authenticate with your credentials:

```bash
curl -X POST http://localhost:3000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com", "password": "YourPassword1!" }'
```

The response contains an `accessToken` and a `refreshToken`.

## Using tokens

Include the access token in the `Authorization` header for protected
endpoints:

```bash
curl http://localhost:3000/api/users/me \
  -H "Authorization: Bearer <accessToken>"
```

## Refreshing tokens

When the access token expires, use the refresh token to obtain a new pair:

```bash
curl -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<refreshToken>" }'
```

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
  -d '{ "token": "<resetToken>", "password": "NewPassword1!" }'
```

## Next steps

- See the **Organizations** guide to create teams and manage roles.
- Browse the endpoint reference for the full list of auth routes.
