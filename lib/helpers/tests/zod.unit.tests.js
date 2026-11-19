/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';

import { isObjectId, objectId, pageQuery } from '../zod.js';

describe('zod helpers unit tests:', () => {
  const id = '507f1f77bcf86cd799439011';

  test('isObjectId accepts 24-hex ids in either case and rejects the rest', () => {
    expect(isObjectId(id)).toBe(true);
    expect(isObjectId(id.toUpperCase())).toBe(true);
    expect(isObjectId(`${id}0`)).toBe(false);
    expect(isObjectId('not-an-id')).toBe(false);
    expect(isObjectId(undefined)).toBe(false);
  });

  test('objectId schema validates with the given message', () => {
    expect(objectId().safeParse(id).success).toBe(true);
    const result = objectId('orgId must be a valid ObjectId').safeParse('nope');
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toBe('orgId must be a valid ObjectId');
  });

  test('pageQuery without defaultSize leaves both fields optional', () => {
    expect(pageQuery({ firstPage: 0 }).parse({})).toEqual({});
    expect(pageQuery({ firstPage: 0 }).parse({ page: '0', perPage: '10' })).toEqual({ page: 0, perPage: 10 });
  });

  test('pageQuery with defaultSize defaults page and size', () => {
    expect(pageQuery({ defaultSize: 20 }).parse({})).toEqual({ page: 1, perPage: 20 });
    expect(pageQuery({ sizeKey: 'limit', defaultSize: 20 }).parse({ page: '3' })).toEqual({ page: 3, limit: 20 });
  });

  test('pageQuery rejects a page below firstPage and a size above maxSize', () => {
    expect(pageQuery().safeParse({ page: '0' }).success).toBe(false);
    expect(pageQuery().safeParse({ perPage: '101' }).success).toBe(false);
  });
});
