/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { jest, beforeAll } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Unit tests
 */
describe('Uploads integration tests:', () => {
  let UserService;
  let UploadsService;
  let UploadsDataService;
  let UploadRepository;
  let agent;
  let credentials;
  let user;
  let _user;
  let upload1;

  //  init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      UploadsService = (await import(path.resolve('./modules/uploads/services/uploads.service.js'))).default;
      UploadsDataService = (await import(path.resolve('./modules/uploads/services/uploads.data.service.js'))).default;
      UploadRepository = (await import(path.resolve('./modules/uploads/repositories/uploads.repository.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Logged', () => {
    beforeEach(async () => {
      // user credentials
      credentials = {
        email: 'upload@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      };

      // user
      _user = {
        firstName: 'Full',
        lastName: 'Name',
        email: credentials.email,
        password: credentials.password,
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

      // add a upload
      try {
        const result = await agent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);
        upload1 = result.body.data.avatar;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve a single uploaded file', async () => {
      // add upload
      try {
        const result = await agent.get(`/api/uploads/${upload1}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve an uploaded image file', async () => {
      // add upload
      try {
        const result = await agent.get(`/api/uploads/images/${upload1}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve an uploaded image file with size option', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-512.${input[1]}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve an uploaded image file with size option and blur effect', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-512-blur.${input[1]}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve an uploaded image file with size option and bw effect', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-512-bw.${input[1]}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to retrieve an uploaded image file with size option and blur&bw effect', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-512-blur&bw.${input[1]}`).expect(200);
        expect(result.body).toBeInstanceOf(Buffer);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return an error for incorrect file name schema when retrieving an uploaded image', async () => {
      // add upload
      try {
        const result = await agent.get('/api/uploads/images/test').expect(404);
        expect(result.body.message).toEqual('Not Found');
        expect(result.body.description).toEqual('Wrong name schema');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return an error when too many parameters are provided during image retrieval', async () => {
      // add upload
      try {
        const result = await agent.get('/api/uploads/images/filename-400-blur-test.png').expect(404);
        expect(result.body.message).toEqual('Not Found');
        expect(result.body.description).toEqual('Too much params');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return an error when attempting to retrieve an uploaded image with an incorrect name', async () => {
      // add upload
      try {
        const result = await agent.get('/api/uploads/images/filename-400-blur.png').expect(404);
        expect(result.body.message).toEqual('Not Found');
        expect(result.body.description).toEqual('No Upload with that name has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return an error for incorrect size parameter during image retrieval', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-300.${input[1]}`).expect(422);
        expect(result.body.message).toEqual('Unprocessable Entity');
        expect(result.body.description).toEqual('Wrong size param');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return an error for wrong size parameter during image retrieval', async () => {
      // add upload
      try {
        const input = upload1.split('.');
        const result = await agent.get(`/api/uploads/images/${input[0]}-512-toto.${input[1]}`).expect(422);
        expect(result.body.message).toEqual('Unprocessable Entity');
        expect(result.body.description).toEqual('Operation param not available');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should successfully delete an uploaded image file', async () => {
      // add upload
      try {
        const result = await agent.delete(`/api/uploads/${upload1}`).expect(200);
        expect(result.body.message).toEqual('upload deleted');
        upload1 = null; // protect afterEach delete
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should invalidate access to the old uploaded file after updating it', async () => {
      try {
        const result = await agent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('profile avatar updated');
        expect(result.body.data).toBeInstanceOf(Object);
        expect(typeof result.body.data.avatar).toBe('string');
        expect(result.body.data.id).toBe(String(user.id));

        const _new = await agent.get(`/api/uploads/${result.body.data.avatar}`).expect(200);
        expect(_new.body).toBeDefined();

        const _old = await agent.get(`/api/uploads/${upload1}`).expect(404);
        expect(_old.body).toBeDefined();
        expect(_old.body.type).toBe('error');
        expect(_old.body.message).toBe('Not Found');

        await agent.delete(`/api/uploads/${result.body.data.avatar}`).expect(200);
        upload1 = null; // protect afterEach delete
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 422 when get stream fails', async () => {
      jest.spyOn(UploadsService, 'getStream').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get(`/api/uploads/${upload1}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when getSharp stream fails', async () => {
      jest.spyOn(UploadsService, 'getStream').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get(`/api/uploads/images/${upload1}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 422 when remove fails', async () => {
      jest.spyOn(UploadsService, 'remove').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.delete(`/api/uploads/${upload1}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should return 500 when uploadByName middleware throws', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(UploadsService, 'get').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get(`/api/uploads/${upload1}`).expect(500);
      expect(result.body.message).toBe('DB error');
      consoleSpy.mockRestore();
    });

    afterEach(async () => {
      try {
        if (upload1) await agent.delete(`/api/uploads/${upload1}`).expect(200);
        await UserService.remove(user);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Public (unauthenticated)', () => {
    let authAgent;
    let publicAgent;
    let publicUser;
    let publicUpload;

    beforeAll(async () => {
      const init = await bootstrap();
      authAgent = request.agent(init.app);
      publicAgent = request(init.app);

      const creds = { email: 'upload-public@test.com', password: 'W@os.jsI$Aw3$0m3' };
      const result = await authAgent.post('/api/auth/signup').send({ firstName: 'Public', lastName: 'Test', ...creds, provider: 'local' }).expect(200);
      publicUser = result.body.user;

      const uploadResult = await authAgent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);
      publicUpload = uploadResult.body.data.avatar;
    });

    test('should allow unauthenticated access to images', async () => {
      const result = await publicAgent.get(`/api/uploads/images/${publicUpload}`).expect(200);
      expect(result.body).toBeInstanceOf(Buffer);
    });

    test('should deny unauthenticated access to raw uploads', async () => {
      await publicAgent.get(`/api/uploads/${publicUpload}`).expect(401);
    });

    afterAll(async () => {
      try {
        await authAgent.delete(`/api/uploads/${publicUpload}`);
        const UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
        await UserService.remove(publicUser);
      } catch (err) {
        console.log(err);
      }
    });
  });

  describe('Data', () => {
    beforeAll(async () => {
      // user credentials
      credentials = {
        email: 'upload@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      };

      // user
      _user = {
        firstName: 'Full',
        lastName: 'Name',
        email: credentials.email,
        password: credentials.password,
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

      // add a upload
      try {
        const result = await agent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);
        upload1 = result.body.data.avatar;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should be able to list user uploaded data', async () => {
      try {
        const result = await UploadsDataService.list(user);
        expect(result).toBeInstanceOf(Array);
        expect(result).toHaveLength(1);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to remove user uploaded data', async () => {
      try {
        const result = await UploadsDataService.remove(user);
        expect(result).toBeInstanceOf(Object);
        expect(result.deletedCount).toBe(1);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log('tata', err);
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

  describe('Cron', () => {
    test('should be able to purge data not linked to another entity', async () => {
      try {
        const _user2 = { ..._user };
        _user2.email = 'upload2@test.com';
        const resultUser = await agent.post('/api/auth/signup').send(_user2).expect(200);
        const user = resultUser.body.user;
        const uploadResult = await agent.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200);
        const orphanAvatar = uploadResult.body.data.avatar;
        await UserService.remove(user);
        const result = await UploadRepository.purge('avatar', 'users', 'avatar');
        expect(result.deletedCount).toBeGreaterThanOrEqual(1);
        const removedUpload = await UploadRepository.get(orphanAvatar);
        expect(removedUpload).toBeFalsy();
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
