/**
 * Per-module project config template.
 *
 * This file overrides module-level defaults for a specific downstream project.
 * Naming: {module}.{project}.config.js (e.g. users.trawl.config.js)
 *
 * Load order (lowest → highest priority):
 *   1. {module}.development.config.js  — module defaults
 *   2. config/defaults/{project}.config.js  — global project overrides
 *   3. {module}.{project}.config.js  — per-module project overrides  ← this file
 *   4. DEVKIT_NODE_* env vars
 *
 * Usage:
 *   1. Copy and rename to {module}.{yourproject}.config.js
 *   2. Set NODE_ENV={yourproject} when running the app
 *   3. Override only the keys you need — development defaults apply for all others
 *
 * @example NODE_ENV=trawl npm start
 */
export default {
  // whitelists: {
  //   users: {
  //     roles: ['user', 'admin', 'custom-role'],
  //   },
  // },
};
