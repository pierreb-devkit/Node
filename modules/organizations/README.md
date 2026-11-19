# Organizations Module

Organizations, memberships and the current-organization switch.

## Organization removal — the cleanup hook

Removing an organization (`OrganizationsService.remove`, `organizations.crud.service.js`) first runs the before-removal guards (see below), then tears down what organizations owns — memberships, each affected user's `currentOrganization`, the organization document — then fires the org-removal hook so every other module cleans its own organization-scoped data.

The hook is the **one extension point** for this, for stack and downstream modules alike. A module never edits `organizations.crud.service.js` to add its cleanup.

```js
// modules/<your-module>/<your-module>.init.js
import { onOrganizationRemoved } from '../organizations/lib/organizations.removal.registry.js';

export default async () => {
  onOrganizationRemoved(async ({ organizationId, organization }) => {
    const { default: MyService } = await import('./services/my.service.js');
    await MyService.deleteByOrganization(organizationId);
  });
};
```

- **Register in your module's own `*.init.js`.** Init files are auto-discovered and run at boot; a deactivated module's init never runs, so its handler is never registered.
- **Payload:** `{ organizationId, organization }` — the id and the removed document (already deleted from the database).
- **Scope:** touch only rows that belong to that organization. Validate the id before writing, so a missing id can never widen the filter. Records that must be retained (billing) are anonymized, not deleted.
- **Errors:** handlers run one after the other and are isolated — a handler that throws never stops the next one. Throw on failure rather than swallowing it: every failure is logged with the organization id for manual reconciliation. The removal itself never fails because of a handler, since it already happened.
- **No new state, no job:** a handler cleans what exists at removal time.

Registered by the stack today:

| Module | Cleanup |
| --- | --- |
| `tasks` | deletes the organization's tasks |
| `billing` | keeps the subscription and the extras balance (ledger included: packs, grants, referral entries) anonymized: the organization reference is replaced with one fresh tombstone id per removal, nothing else changes (`modules/billing/STRIPE_SETUP.md` §4). Deletes the usage documents. |
| `uploads` | deletes the organization's uploads (`metadata.organizationId`, stored as an ObjectId or a string), files and chunks |

The stack does not call the payment provider on removal. A live paid subscription is never left charging: the billing guard below refuses the removal until the subscription is cancelled.

## Organization removal — the guard hook

A module can refuse a removal with `onBeforeOrganizationRemoved(fn)`, registered the same way in its own `*.init.js`. Guards run **before anything is deleted**, one after the other.

```js
// modules/<your-module>/<your-module>.init.js
import { onBeforeOrganizationRemoved } from '../organizations/lib/organizations.removal.registry.js';

export default async () => {
  onBeforeOrganizationRemoved(async ({ organizationId, organization }) => {
    const { default: MyService } = await import('./services/my.service.js');
    await MyService.assertRemovable(organizationId, organization); // throws to refuse
  });
};
```

- **Refuse by throwing** an `AppError` with a 4xx status and a stable `code`; the first guard that throws stops the removal and its error reaches the client unchanged. Resolving lets the removal go on.
- **Payload:** `{ organizationId, organization }` — the organization is still in the database.
- **Every removal path** runs the guards: `DELETE /api/organizations/:id`, and account deletion (`DELETE /api/users`, `DELETE /api/admin/users/:userId`), which checks every organization the user solely owns before deleting anything. `OrganizationsService.assertRemovable(organization)` runs the guards without deleting.

Registered by the stack today:

| Module | Guard |
| --- | --- |
| `billing` | refuses with **409** `ORGANIZATION_HAS_LIVE_SUBSCRIPTION` while the organization's paid subscription is `active`, `trialing` or `past_due` — description `Cancel the subscription of "<organization name>" before removing it.` A free organization, a canceled subscription, or one already set to end (`cancelAtPeriodEnd`, or a `cancelAt` date as a customer-portal cancel writes) is not refused. |
