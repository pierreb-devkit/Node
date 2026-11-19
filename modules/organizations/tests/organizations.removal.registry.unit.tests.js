/**
 * Unit tests for the organization-removal subscriber registry.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
  onBeforeOrganizationRemoved,
  runBeforeOrganizationRemovedGuards,
  onOrganizationRemoved,
  runOrganizationRemovedHandlers,
  _reset,
} from '../lib/organizations.removal.registry.js';

describe('organizations.removal.registry', () => {
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

  test('isolates a handler error — the remaining handlers still run, then failures re-raise as one AggregateError', async () => {
    const boom = new Error('cleanup failed');
    const after = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(async () => {
      throw boom;
    });
    onOrganizationRemoved(after);

    await expect(runOrganizationRemovedHandlers({ organizationId: 'org-1' })).rejects.toThrow(AggregateError);
    // A failing handler must not block a later one (avoids orphaning another module's rows).
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('aggregates every handler failure — each error is carried on the AggregateError', async () => {
    const boomA = new Error('tasks cleanup failed');
    const boomB = new Error('files cleanup failed');
    const middle = jest.fn().mockResolvedValue(undefined);
    onOrganizationRemoved(async () => {
      throw boomA;
    });
    onOrganizationRemoved(middle);
    onOrganizationRemoved(async () => {
      throw boomB;
    });

    await expect(runOrganizationRemovedHandlers({ organizationId: 'org-1' })).rejects.toMatchObject({
      errors: [boomA, boomB],
    });
    expect(middle).toHaveBeenCalledTimes(1);
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

  describe('before-removal guards (#4321)', () => {
    test('runs every guard with the payload when none refuses', async () => {
      const a = jest.fn().mockResolvedValue(undefined);
      const b = jest.fn().mockResolvedValue(undefined);
      onBeforeOrganizationRemoved(a);
      onBeforeOrganizationRemoved(b);
      const payload = { organizationId: 'org-1', organization: { _id: 'org-1' } };

      await expect(runBeforeOrganizationRemovedGuards(payload)).resolves.toBeUndefined();

      expect(a).toHaveBeenCalledWith(payload);
      expect(b).toHaveBeenCalledWith(payload);
    });

    test('propagates the first refusal unchanged (not wrapped) and stops the run', async () => {
      const refusal = Object.assign(new Error('refused'), { status: 409, code: 'REFUSED' });
      const after = jest.fn();
      onBeforeOrganizationRemoved(async () => {
        throw refusal;
      });
      onBeforeOrganizationRemoved(after);

      await expect(runBeforeOrganizationRemovedGuards({ organizationId: 'org-1' })).rejects.toBe(refusal);
      expect(after).not.toHaveBeenCalled();
    });

    test('guards and handlers are separate: a guard never runs as a removal handler', async () => {
      const guard = jest.fn();
      onBeforeOrganizationRemoved(guard);

      await runOrganizationRemovedHandlers({ organizationId: 'org-1' });

      expect(guard).not.toHaveBeenCalled();
    });

    test('rejects a non-function guard registration', () => {
      expect(() => onBeforeOrganizationRemoved(null)).toThrow(TypeError);
    });

    test('_reset clears registered guards', async () => {
      const guard = jest.fn();
      onBeforeOrganizationRemoved(guard);
      _reset();

      await runBeforeOrganizationRemovedGuards({ organizationId: 'org-1' });

      expect(guard).not.toHaveBeenCalled();
    });
  });
});
