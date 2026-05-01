# Cron Scripts

## Migration notice (2026-05-01, #3546)

Billing-specific crons have been relocated to `modules/billing/crons/`. The old paths at `scripts/crons/billing.*.js` no longer exist. Downstream projects must run `/update-stack` to pick up the move, AND infra K8s CronJob manifests pointing to `args: ["scripts/crons/billing.*.js"]` must be updated to `args: ["modules/billing/crons/billing.*.js"]` in the same cutover window.

Expect a brief (≤5 min) CronJob outage during the cutover — acceptable per #3546.

See `docs/migrations/2026-05-01-billing-crons-module-relocation.md` for the full procedure.

---

Standalone CLI scripts intended to be executed as Kubernetes CronJobs.
No `node-cron` dependency — orchestration is handled by Kubernetes CronJob manifests.

## Billing cron scripts

Billing cron scripts now live at `modules/billing/crons/`. See `modules/billing/crons/README.md` for usage, schedule, and K8s manifest examples.
