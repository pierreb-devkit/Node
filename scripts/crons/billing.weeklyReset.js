// LEGACY SHIM — remove ~2026-07-01
// Forwards to the canonical location after #3546 relocation.
// Kept so infra K8s manifests + downstream `scripts/crons/` references keep working
// during the migration window. Tracked in docs/migrations/2026-05-01-billing-crons-module-relocation.md.
await import('../../modules/billing/crons/billing.weeklyReset.js');
