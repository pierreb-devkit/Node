/**
 * Module dependencies.
 */
import { describe, expect, test } from '@jest/globals';

import schema from '../models/organizations.schema.js';

/**
 * Unit tests for organizations.schema.js
 */
describe('organizations.schema unit tests:', () => {
  test('Organization defaults meterExempt to false', () => {
    const result = schema.Organization.parse({
      name: 'Acme',
    });

    expect(result.meterExempt).toBe(false);
  });

  test('Organization accepts meterExempt=true', () => {
    const result = schema.Organization.parse({
      name: 'Acme',
      meterExempt: true,
    });

    expect(result.meterExempt).toBe(true);
  });
});
