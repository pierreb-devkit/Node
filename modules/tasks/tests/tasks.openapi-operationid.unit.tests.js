import { describe, test, expect } from '@jest/globals';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('modules/tasks/doc/tasks.yml — OpenAPI operationIds:', () => {
  const specPath = path.resolve(__dirname, '../doc/tasks.yml');
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));

  test('every operation has a unique operationId', () => {
    const operationIds = [];
    for (const [, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          expect(operation.operationId).toBeDefined();
          expect(typeof operation.operationId).toBe('string');
          operationIds.push(operation.operationId);
        }
      }
    }
    // Uniqueness check
    expect(new Set(operationIds).size).toBe(operationIds.length);
    // At least one operationId (tasks.yml is not empty)
    expect(operationIds.length).toBeGreaterThan(0);
  });
});
