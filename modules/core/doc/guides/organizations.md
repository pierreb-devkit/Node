# Organizations

Organizations let you group users under a shared context with role-based
access control.

## Creating an organization

```bash
curl -X POST http://localhost:3000/api/organizations \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "My Team" }'
```

The creator is automatically assigned the **owner** role.

## Listing organizations

Retrieve all organizations you belong to:

```bash
curl http://localhost:3000/api/organizations \
  -H "Authorization: Bearer <accessToken>"
```

## Inviting members

Invite a user by email. They receive an invitation they can accept or
decline:

```bash
curl -X POST http://localhost:3000/api/organizations/<orgId>/invitations \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "email": "teammate@example.com", "role": "member" }'
```

## Scoping requests to an organization

The active organization is set via the `X-Organization-Id` header on API
requests:

```bash
curl http://localhost:3000/api/tasks \
  -H "Authorization: Bearer <accessToken>" \
  -H "X-Organization-Id: <orgId>"
```

Most org-scoped resources require this header — omitting it returns data
from the caller's default organization (if any) or an empty set.

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
