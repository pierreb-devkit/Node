/**
 * Unit tests for filterByActivation in config helper.
 */
import configHelper from '../config.js';

const { filterByActivation, CORE_MODULES } = configHelper;

describe('filterByActivation', () => {
  const files = [
    'modules/core/routes/core.routes.js',
    'modules/auth/routes/auth.routes.js',
    'modules/users/routes/users.routes.js',
    'modules/home/routes/home.routes.js',
    'modules/tasks/routes/tasks.routes.js',
    'modules/billing/routes/billing.routes.js',
    'modules/audit/models/audit.mongoose.js',
    'modules/organizations/policies/organizations.policy.js',
    'modules/uploads/routes/uploads.routes.js',
  ];

  it('should keep all files when all modules are activated (default)', () => {
    const config = {
      tasks: { activated: true },
      billing: { activated: true },
      audit: { activated: true },
      organizations: { activated: true },
      uploads: { activated: true },
    };
    const result = filterByActivation(files, config);
    expect(result).toEqual(files);
  });

  it('should filter out files from a deactivated non-core module', () => {
    const config = {
      tasks: { activated: false },
      billing: { activated: true },
    };
    const result = filterByActivation(files, config);
    expect(result).not.toContain('modules/tasks/routes/tasks.routes.js');
    expect(result).toContain('modules/billing/routes/billing.routes.js');
  });

  it('should filter out multiple deactivated modules', () => {
    const config = {
      tasks: { activated: false },
      billing: { activated: false },
      audit: { activated: false },
    };
    const result = filterByActivation(files, config);
    expect(result).not.toContain('modules/tasks/routes/tasks.routes.js');
    expect(result).not.toContain('modules/billing/routes/billing.routes.js');
    expect(result).not.toContain('modules/audit/models/audit.mongoose.js');
    // Core modules still present
    expect(result).toContain('modules/core/routes/core.routes.js');
    expect(result).toContain('modules/auth/routes/auth.routes.js');
    expect(result).toContain('modules/users/routes/users.routes.js');
    expect(result).toContain('modules/home/routes/home.routes.js');
  });

  it('should never filter out core modules even if activated is false', () => {
    const config = {
      core: { activated: false },
      auth: { activated: false },
      users: { activated: false },
      home: { activated: false },
    };
    const result = filterByActivation(files, config);
    expect(result).toContain('modules/core/routes/core.routes.js');
    expect(result).toContain('modules/auth/routes/auth.routes.js');
    expect(result).toContain('modules/users/routes/users.routes.js');
    expect(result).toContain('modules/home/routes/home.routes.js');
  });

  it('should default to active when activated key is missing', () => {
    const config = {
      tasks: { someOtherSetting: true }, // no activated key
    };
    const result = filterByActivation(files, config);
    expect(result).toContain('modules/tasks/routes/tasks.routes.js');
  });

  it('should default to active when module has no config at all', () => {
    const config = {}; // no module configs
    const result = filterByActivation(files, config);
    expect(result).toEqual(files);
  });

  it('should keep non-module files (no modules/ in path)', () => {
    const mixedFiles = [
      'config/defaults/development.config.js',
      'lib/helpers/config.js',
      'modules/tasks/routes/tasks.routes.js',
    ];
    const config = { tasks: { activated: false } };
    const result = filterByActivation(mixedFiles, config);
    expect(result).toContain('config/defaults/development.config.js');
    expect(result).toContain('lib/helpers/config.js');
    expect(result).not.toContain('modules/tasks/routes/tasks.routes.js');
  });

  it('should handle empty file array', () => {
    const result = filterByActivation([], {});
    expect(result).toEqual([]);
  });

  it('should define core, auth, users, home as core modules', () => {
    expect(CORE_MODULES.has('core')).toBe(true);
    expect(CORE_MODULES.has('auth')).toBe(true);
    expect(CORE_MODULES.has('users')).toBe(true);
    expect(CORE_MODULES.has('home')).toBe(true);
    expect(CORE_MODULES.has('tasks')).toBe(false);
    expect(CORE_MODULES.has('billing')).toBe(false);
  });
});
