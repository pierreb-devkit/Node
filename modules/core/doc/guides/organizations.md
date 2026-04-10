# Organizations

Organizations let you group users under a shared context with role-based
access control.

All examples below assume you are already authenticated and send the
`TOKEN` cookie set at signin (see the **Authentication** guide).

## Creating an organization

```bash
curl -X POST http://localhost:3000/api/organizations \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{ "name": "My Team" }'
```

The creator is automatically assigned the **owner** role.

## Listing organizations

Retrieve all organizations you belong to:

```bash
curl http://localhost:3000/api/organizations \
  -b cookies.txt
```

## Inviting members

Invite a user by email. They receive an invitation they can accept or
decline:

```bash
curl -X POST http://localhost:3000/api/organizations/<orgId>/invites \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{ "email": "teammate@example.com", "role": "member" }'
```

The invitee then accepts (or declines) via the invite token they receive
by email:

```bash
curl -X POST http://localhost:3000/api/invites/<token>/accept \
  -b cookies.txt
```

## Scoping requests to an organization

The API does not use an `X-Organization-Id` header. Org context is
resolved in one of two ways:

1. **Route parameter** — org-scoped routes include `:organizationId` in
   the path, e.g. `/api/organizations/:organizationId/invites`. Pass the
   org id directly in the URL.
2. **Current organization** — the authenticated user has a
   `currentOrganization` stored server-side. Switch it with:

   ```bash
   curl -X POST http://localhost:3000/api/organizations/<orgId>/switch \
     -b cookies.txt
   ```

   This updates `user.currentOrganization`, issues a fresh JWT cookie,
   and rebuilds abilities. Subsequent requests that rely on the current
   org (rather than a route param) use that value.

## Roles

| Role | Permissions |
|------|-------------|
| **owner** | Full access, manage billing, delete organization |
| **admin** | Manage members, update settings |
| **member** | Access shared resources |

Roles are enforced by CASL abilities on the backend — see each
organization endpoint for the required ability.

## Next steps

- Browse the endpoint reference for the full list of organization routes.
