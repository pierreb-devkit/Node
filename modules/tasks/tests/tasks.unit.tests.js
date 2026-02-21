/**
 * Module dependencies.
 */
import schema from '../models/tasks.schema.js';

/**
 * Unit tests
 */
describe('Tasks unit tests:', () => {
  let task;

  beforeEach(() => {
    task = {
      title: 'title',
      description: 'do something about something else',
    };
  });

  test('should be valid a task example without problems', (done) => {
    const result = schema.Task.safeParse(task);
    expect(typeof result).toBe('object');
    expect(result.error).toBeFalsy();
    done();
  });

  test('should be able to show an error when trying a schema without title', (done) => {
    task.title = '';

    const result = schema.Task.safeParse(task);
    expect(typeof result).toBe('object');
    expect(result.error).toBeDefined();
    done();
  });

  test('should be able to show an error when trying a schema without description', (done) => {
    task.description = null;

    const result = schema.Task.safeParse(task);
    expect(typeof result).toBe('object');
    expect(result.error).toBeDefined();
    done();
  });

  test('should not show an error when trying a schema with user', (done) => {
    task.user = '507f1f77bcf86cd799439011';

    const result = schema.Task.safeParse(task);
    expect(typeof result).toBe('object');
    expect(result.error).toBeFalsy();
    done();
  });

  test('should be able remove unknown when trying a different schema', (done) => {
    task.toto = '';

    const result = schema.Task.safeParse(task);
    expect(result.toto).toBeUndefined();
    done();
  });
});
