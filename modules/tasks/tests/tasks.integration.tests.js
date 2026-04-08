/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { jest, afterAll, beforeAll } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Unit tests
 */
describe('Tasks integration tests:', () => {
  let UserService;
  const originalOrgEnabled = config.organizations.enabled;
  let TasksService;
  let TasksDataService;
  let app; // Express app instance for fresh (unauthenticated) requests
  let agent;
  let user;
  let _user;
  let _tasks;
  let task1;
  let task2;

  //  init
  beforeAll(async () => {
    // Disable organizations so signup auto-creates a silent org with membership
    config.organizations.enabled = false;
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      TasksService = (await import(path.resolve('./modules/tasks/services/tasks.service.js'))).default;
      TasksDataService = (await import(path.resolve('./modules/tasks/services/tasks.data.service.js'))).default;
      app = init.app;
      agent = request.agent(app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Logged', () => {
    beforeEach(async () => {
      // user
      _user = {
        firstName: 'Full',
        lastName: 'Name',
        email: 'task@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      };

      // add user
      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // tasks
      _tasks = [
        {
          title: 'title1',
          description: 'do something about something else',
        },
        {
          title: 'title2',
          description: 'do something about something else',
        },
        {
          title: 'title3',
          description: 'do something about something else',
        },
      ];

      // add a task
      try {
        const result = await agent.post('/api/tasks').send(_tasks[0]).expect(200);
        task1 = result.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to save a task', async () => {
      // add task
      try {
        const result = await agent.post('/api/tasks').send(_tasks[1]).expect(200);
        task2 = result.body.data;
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task created');
        expect(result.body.data.title).toBe(_tasks[1].title);
        expect(result.body.data.description).toBe(_tasks[1].description);
        expect(result.body.data.user.id).toBe(user.id);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to save a task with bad model', async () => {
      // add task
      try {
        const result = await agent
          .post('/api/tasks')
          .send({
            title: 2,
            description: 'do something about something else',
          })
          .expect(422);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toEqual('Schema validation error');
        expect(result.body.description).toBe('Invalid input: expected string, received number. ');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to get a task', async () => {
      // get task created in beforeEach (task1)
      try {
        const result = await agent.get(`/api/tasks/${task1.id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task get');
        expect(result.body.data.id).toBe(task1.id);
        expect(result.body.data.title).toBe(_tasks[0].title);
        expect(result.body.data.description).toBe(_tasks[0].description);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to get a task with a bad mongoose id', async () => {
      // delete task
      try {
        const result = await agent.get('/api/tasks/test').expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Task with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to get a task with a bad invented id', async () => {
      // delete task
      try {
        const result = await agent.get('/api/tasks/node56397898004243871228').expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Task with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to create, update, and delete his own task', async () => {
      // edit task
      try {
        const resultCreate = await agent.post('/api/tasks').send(_tasks[2]).expect(200);

        const task3 = resultCreate.body.data;
        expect(resultCreate.body.type).toBe('success');
        expect(resultCreate.body.message).toBe('task created');
        task3.title = 'taskUpdated';

        const resultUpdate = await agent.put(`/api/tasks/${task3.id}`).send({ title: task3.title, description: task3.description }).expect(200);
        expect(resultUpdate.body.type).toBe('success');
        expect(resultUpdate.body.message).toBe('task updated');
        expect(resultUpdate.body.data.id).toBe(task3.id);
        expect(resultUpdate.body.data.title).toBe('taskUpdated');

        const result = await agent.delete(`/api/tasks/${task3.id}`).expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task deleted');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to update a task if it is not a user task', async () => {
      // edit task
      try {
        const result = await agent.put(`/api/tasks/${task2.id}`).send(_tasks[0]).expect(403);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Unauthorized');
        expect(result.body.description).toBe('User is not authorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to update a task with a bad id', async () => {
      // edit task
      try {
        const result = await agent.put('/api/tasks/test').send(_tasks[0]).expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Task with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to remove a task if it is not a user task', async () => {
      // edit task
      try {
        const result = await agent.delete(`/api/tasks/${task2.id}`).send(_tasks[0]).expect(403);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Unauthorized');
        expect(result.body.description).toBe('User is not authorized');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to remove a task with a bad id', async () => {
      // edit task
      try {
        const result = await agent.delete(`/api/tasks/test`).send(_tasks[0]).expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No Task with that identifier has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to get list of tasks', async () => {
      // get list — org-scoped, so only tasks from the current user's org are returned
      try {
        const result = await agent.get('/api/tasks').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('task list');
        expect(result.body.data).toBeInstanceOf(Array);
        expect(result.body.data.length).toBeGreaterThanOrEqual(1);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to get tasks stats when authenticated (org-scoped)', async () => {
      try {
        const tasksResult = await agent.get('/api/tasks').expect(200);
        expect(tasksResult.body.type).toBe('success');
        expect(tasksResult.body.message).toBe('task list');
        expect(tasksResult.body.data).toBeInstanceOf(Array);

        const result = await agent.get('/api/tasks/stats').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('tasks stats');
        expect(typeof result.body.data).toBe('number');
        expect(result.body.data).toBe(tasksResult.body.data.length);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterEach(async () => {
      // del task
      try {
        await agent.delete(`/api/tasks/${task1.id}`).expect(200);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      // del user
      try {
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Logout', () => {
    test('should not be able to save a task', async () => {
      try {
        const result = await request(app).post('/api/tasks').send(_tasks[0]).expect(401);
        expect(result.error.text).toBe('Unauthorized');
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should not be able to get list of tasks without auth', async () => {
      try {
        await request(app).get('/api/tasks').expect(401);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should not be able to get tasks stats without auth', async () => {
      try {
        await request(app).get('/api/tasks/stats').expect(401);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });
  });

  describe('Data', () => {
    beforeAll(async () => {
      // user
      _user = {
        firstName: 'Full',
        lastName: 'Name',
        email: 'task@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      };

      // add user
      try {
        const result = await agent.post('/api/auth/signup').send(_user).expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }

      // tasks
      _tasks = [
        {
          title: 'title1',
          description: 'do something about something else',
          user: user.id,
          _id: '64f1f177cb9cf84ed815acec',
        },
        {
          title: 'title2',
          description: 'do something about something else',
          user: user.id,
          _id: '64f1f177cb9cf84ed815aced',
        },
      ];
    });

    test('should be able to push a list of user tasks data', async () => {
      try {
        const result = await TasksDataService.push(_tasks, ['_id']);
        expect(result).toBeInstanceOf(Object);
        expect(result.upsertedCount).toBe(2);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to list user tasks data', async () => {
      try {
        const result = await TasksDataService.list(user);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(2);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to remove user tasks data', async () => {
      try {
        const result = await TasksDataService.remove(user);
        expect(result).toBeInstanceOf(Object);
        expect(result.deletedCount).toBe(2);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    afterAll(async () => {
      // del user
      try {
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Errors', () => {
    let errorUser;
    let errorTask;

    beforeAll(async () => {
      try {
        const result = await agent.post('/api/auth/signup').send({
          firstName: 'Error',
          lastName: 'Task',
          email: 'taskerror@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        }).expect(200);
        errorUser = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
      try {
        const taskResult = await agent.post('/api/tasks').send({ title: 'errtask', description: 'err desc' }).expect(200);
        errorTask = taskResult.body.data;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 422 when list fails', async () => {
      jest.spyOn(TasksService, 'list').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/tasks').expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when create fails', async () => {
      jest.spyOn(TasksService, 'create').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.post('/api/tasks').send({ title: 'test', description: 'desc' }).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when update fails', async () => {
      jest.spyOn(TasksService, 'update').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.put(`/api/tasks/${errorTask.id}`).send({ title: 'upd', description: 'desc' }).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when remove fails', async () => {
      jest.spyOn(TasksService, 'remove').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.delete(`/api/tasks/${errorTask.id}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when stats fails', async () => {
      jest.spyOn(TasksService, 'stats').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/tasks/stats').expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    afterAll(async () => {
      try {
        await agent.delete(`/api/tasks/${errorTask.id}`);
      } catch (_) { /* cleanup – ignore errors */ }
      try {
        await UserService.remove(errorUser);
      } catch (_) { /* cleanup – ignore errors */ }
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    config.organizations.enabled = originalOrgEnabled;
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
