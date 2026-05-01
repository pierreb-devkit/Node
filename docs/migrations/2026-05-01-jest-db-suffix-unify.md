# Migration: unified per-process jest DB suffix (2026-05-01)

## Why

Two overlapping mechanisms both tried to give jest invocations a unique MongoDB database name (#3563):

1. `config/defaults/test.config.js` embedded `process.pid` in the default URI.
2. `config/index.js` appended `_w${JEST_WORKER_ID}` after final merge.

This created a 251-line orchestrator script (`scripts/parallel-integration.smoke.js`) and a dedicated CI job to validate the per-pid path separately. The two mechanisms were additive by accident, not by design — when both applied, the URI ended up as `NodeTest_${pid}_w${workerId}`, which was correct, but neither mechanism alone was sufficient, and the interaction was undocumented.

## Before / After

**Before (two mechanisms):**

`config/defaults/test.config.js`:
```js
uri: `mongodb://127.0.0.1:27017/NodeTest_${process.pid}`
```

`config/index.js` (worker-only block):
```js
if (process.env.NODE_ENV === 'test' && process.env.JEST_WORKER_ID) {
  // append _w${workerId}
}
```

Effective URI: `mongodb://127.0.0.1:27017/NodeTest_<pid>_w<workerId>` (when both fired)

**After (single mechanism in `config/index.js`):**

`config/defaults/test.config.js`:
```js
uri: 'mongodb://127.0.0.1:27017/NodeTest'
```

`config/index.js` (unified block, always runs in test):
```js
if (process.env.NODE_ENV === 'test') {
  // append _p${pid}_w${workerId} (workerId = '0' when JEST_WORKER_ID unset)
}
```

Effective URI: `mongodb://127.0.0.1:27017/NodeTest_p<pid>_w<workerId>`

The `/test/i` drop-guard in `scripts/jest.globalSetup.js` still matches — `NodeTest_p...` contains `test`.

## Dropped artefacts

- `scripts/parallel-integration.smoke.js` (251 LOC orchestrator) — removed via `git rm`.
- `npm run test:parallel-smoke` script — removed from `package.json`.
- `parallel-smoke` CI job — removed from `.github/workflows/CI.yml`.

## Downstream impact

Pure refactor — no downstream config changes required. `/update-stack` propagates automatically.

Downstream projects using `DEVKIT_NODE_db_uri` explicitly (CI) are unaffected: the suffix appends after Layer 4 override, preserving their per-run isolation.

If a downstream project had custom logic that parsed the old `_${pid}` (no `_p` prefix) format: update the regex to `/_p\d+_w\d+/`.

## Validation

- `npm run test:unit` green — new `scripts/tests/testConfig.dbSuffix.unit.tests.js` verifies all suffix cases.
- `npm run lint` green.
- `scripts/tests/testConfig.perPid.unit.tests.js` updated to match neutral base URI.
