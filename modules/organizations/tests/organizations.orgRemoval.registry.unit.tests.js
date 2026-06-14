/**
 * Unit tests for the organization-removal subscriber registry.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import { onOrganizationRemoved, runOrganizationRemovedHandlers, _reset } from '../lib/orgRemoval.registry.js';

describe('orgRemoval.registry', () => {
  beforeEach(() => {
    _reset();
  });

  test('runs a registered handler with the payload', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(handler);

    const payload = { organizationId: 'org-1', organization: { _id: 'org-1' } };
    await runOrganizationRemovedHandlers(payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  test('runs multiple handlers sequentially in registration order', async () => {
    const order = [];
    onOrganizationRemoved(async () => {
      order.push('first');
    });
    onOrganizationRemoved(async () => {
      order.push('second');
    });

    await runOrganizationRemovedHandlers({ organizationId: 'org-1' });

    expect(order).toEqual(['first', 'second']);
  });

  test('propagates a handler error (does not swallow) and aborts the remaining handlers', async () => {
    const boom = new Error('cleanup failed');
    const after = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(async () => {
      throw boom;
    });
    onOrganizationRemoved(after);

    await expect(runOrganizationRemovedHandlers({ organizationId: 'org-1' })).rejects.toThrow('cleanup failed');
    expect(after).not.toHaveBeenCalled();
  });

  test('runs zero handlers without throwing when none are registered', async () => {
    await expect(runOrganizationRemovedHandlers({ organizationId: 'org-1' })).resolves.toBeUndefined();
  });

  test('rejects a non-function registration', () => {
    expect(() => onOrganizationRemoved('not-a-fn')).toThrow(TypeError);
  });

  test('_reset clears registered handlers', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(handler);
    _reset();

    await runOrganizationRemovedHandlers({ organizationId: 'org-1' });

    expect(handler).not.toHaveBeenCalled();
  });
});
