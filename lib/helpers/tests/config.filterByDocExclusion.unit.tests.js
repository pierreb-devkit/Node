/**
 * Unit tests for filterByDocExclusion in config helper.
 *
 * filterByDocExclusion drops a module's doc files (OpenAPI YAML + guides) from
 * the resolved file lists based on `config.docs.excludeModules`, independent of
 * runtime module activation — so it works even for core modules.
 */
import configHelper from '../config.js';

const { filterByDocExclusion } = configHelper;

describe('filterByDocExclusion', () => {
  const files = [
    'modules/core/doc/index.yml',
    'modules/home/doc/openapi.yml',
    'modules/home/doc/guides/00-welcome.md',
    'modules/home/doc/guides/01-quickstart.md',
    'modules/tasks/doc/tasks.yml',
    'modules/tasks/doc/guides/00-tasks.md',
    'modules/billing/doc/billing.yml',
  ];

  it('should return all files unchanged when excludeModules is missing (no docs config)', () => {
    expect(filterByDocExclusion(files, {})).toEqual(files);
  });

  it('should return all files unchanged when docs exists but excludeModules is missing', () => {
    expect(filterByDocExclusion(files, { docs: { guideSections: [] } })).toEqual(files);
  });

  it('should return all files unchanged when excludeModules is empty (default)', () => {
    expect(filterByDocExclusion(files, { docs: { excludeModules: [] } })).toEqual(files);
  });

  it('should drop OpenAPI yml + guides of an excluded CORE module (no activation bypass)', () => {
    const config = { docs: { excludeModules: ['home'] } };
    const result = filterByDocExclusion(files, config);
    expect(result).not.toContain('modules/home/doc/openapi.yml');
    expect(result).not.toContain('modules/home/doc/guides/00-welcome.md');
    expect(result).not.toContain('modules/home/doc/guides/01-quickstart.md');
    // Other modules' docs untouched
    expect(result).toContain('modules/core/doc/index.yml');
    expect(result).toContain('modules/tasks/doc/tasks.yml');
    expect(result).toContain('modules/billing/doc/billing.yml');
  });

  it('should drop docs of multiple excluded modules', () => {
    const config = { docs: { excludeModules: ['home', 'tasks'] } };
    const result = filterByDocExclusion(files, config);
    expect(result).not.toContain('modules/home/doc/openapi.yml');
    expect(result).not.toContain('modules/home/doc/guides/00-welcome.md');
    expect(result).not.toContain('modules/tasks/doc/tasks.yml');
    expect(result).not.toContain('modules/tasks/doc/guides/00-tasks.md');
    expect(result).toEqual([
      'modules/core/doc/index.yml',
      'modules/billing/doc/billing.yml',
    ]);
  });

  it('should keep non-module files (no modules/ in path)', () => {
    const mixedFiles = [
      'config/defaults/development.config.js',
      'lib/helpers/config.js',
      'modules/home/doc/guides/00-welcome.md',
    ];
    const config = { docs: { excludeModules: ['home'] } };
    const result = filterByDocExclusion(mixedFiles, config);
    expect(result).toContain('config/defaults/development.config.js');
    expect(result).toContain('lib/helpers/config.js');
    expect(result).not.toContain('modules/home/doc/guides/00-welcome.md');
  });

  it('should be a no-op when excludeModules is not an array (defensive)', () => {
    expect(filterByDocExclusion(files, { docs: { excludeModules: 'home' } })).toEqual(files);
    expect(filterByDocExclusion(files, { docs: { excludeModules: null } })).toEqual(files);
  });

  it('should not drop a module whose name is a prefix of an excluded name', () => {
    const prefixFiles = ['modules/home-extras/doc/home-extras.yml'];
    const config = { docs: { excludeModules: ['home'] } };
    expect(filterByDocExclusion(prefixFiles, config)).toEqual(prefixFiles);
  });

  it('should handle empty file array', () => {
    expect(filterByDocExclusion([], { docs: { excludeModules: ['home'] } })).toEqual([]);
  });
});
