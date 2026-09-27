/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for HomeRepository.team() — the DB-level security contract.
 * The public team list must be fetched with a lean, explicit field projection
 * so no sensitive columns or Mongoose virtuals (e.g. `id`) can leak.
 */
describe('HomeRepository.team() projection + lean unit tests:', () => {
  let findMock;
  let leanMock;
  let sortMock;
  let execMock;

  beforeEach(() => {
    jest.resetModules();

    execMock = jest.fn().mockResolvedValue([]);
    sortMock = jest.fn(() => ({ exec: execMock }));
    leanMock = jest.fn(() => ({ sort: sortMock }));
    findMock = jest.fn(() => ({ lean: leanMock }));

    jest.unstable_mockModule('mongoose', () => ({
      default: { model: jest.fn(() => ({ find: findMock })) },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('team() queries admin users with a lean, explicit public-field projection', async () => {
    const { default: HomeRepository } = await import('../repositories/home.repository.js');
    await HomeRepository.team();

    expect(findMock).toHaveBeenCalledWith(
      { roles: 'admin' },
      'firstName lastName bio position avatar -_id',
    );
    expect(leanMock).toHaveBeenCalled();

    // The projection must exclude every sensitive column (defence-in-depth assertion).
    const projection = findMock.mock.calls[0][1];
    expect(projection).not.toMatch(/password|email|salt|resetPassword/);
    // `-_id` excludes the ObjectId so the `id` virtual cannot re-introduce it under lean().
    expect(projection).toContain('-_id');
  });
});

