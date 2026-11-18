/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests — the avatar handlers only ever delete a stored file that
 * belongs to the signed-in user, and `avatar` is set server-side only (by the
 * avatar upload route), never through the profile update route.
 */
describe('Users avatar ownership integration tests:', () => {
  let UserService;
  let UploadsService;
  let app;
  let agentA;
  let agentB;
  let userA;
  let userB;
  let avatarA;

  const password = 'W@os.jsI$Aw3$0m3';

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    UploadsService = (await import(path.resolve('./modules/uploads/services/uploads.service.js'))).default;
  });

  beforeEach(async () => {
    agentA = request.agent(app);
    agentB = request.agent(app);
    userA = (await agentA.post('/api/auth/signup').send({ firstName: 'Ava', lastName: 'Owner', email: 'avatar-owner@test.com', password, provider: 'local' }).expect(200)).body.user;
    userB = (await agentB.post('/api/auth/signup').send({ firstName: 'Bob', lastName: 'Other', email: 'avatar-other@test.com', password, provider: 'local' }).expect(200)).body.user;
    avatarA = (await agentA.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200)).body.data.avatar;
    expect(typeof avatarA).toBe('string');
    expect(await UploadsService.get(avatarA)).toBeTruthy();
  });

  afterEach(async () => {
    for (const u of [userA, userB]) {
      try {
        const stored = u && (await UserService.getBrut({ id: u.id }));
        if (stored?.avatar) await UploadsService.remove({ filename: stored.avatar });
        if (u) await UserService.remove(u);
      } catch (_) { /* cleanup – ignore errors */ }
    }
    try {
      if (avatarA) await UploadsService.remove({ filename: avatarA });
    } catch (_) { /* cleanup – ignore errors */ }
  });

  test('a user cannot point their avatar at another user\'s file through the profile update', async () => {
    await agentB.put('/api/users').send({ avatar: avatarA });
    const storedB = await UserService.getBrut({ id: userB.id });
    expect(storedB.avatar || '').not.toBe(avatarA);
  });

  test('another user\'s file survives a remove-avatar call', async () => {
    await agentB.put('/api/users').send({ avatar: avatarA });
    await agentB.delete('/api/users/avatar');
    expect(await UploadsService.get(avatarA)).toBeTruthy();
  });

  test('another user\'s file survives an update-avatar call', async () => {
    await agentB.put('/api/users').send({ avatar: avatarA });
    await agentB.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg');
    expect(await UploadsService.get(avatarA)).toBeTruthy();
  });

  test('handlers do not delete a stored avatar that is not owned by the user', async () => {
    // Even if `avatar` already holds a foreign file name (e.g. set by an admin
    // or by legacy data), the handler must not delete that file.
    await UserService.update(await UserService.getBrut({ id: userB.id }), { avatar: avatarA });
    const res = await agentB.delete('/api/users/avatar').expect(200);
    expect(res.body.data.avatar).toBeFalsy();
    expect(await UploadsService.get(avatarA)).toBeTruthy();
  });

  test('the owner can still replace and remove their own avatar (old file deleted)', async () => {
    const next = (await agentA.post('/api/users/avatar').attach('avatar', './modules/users/tests/img/default.jpeg').expect(200)).body.data.avatar;
    expect(next).not.toBe(avatarA);
    expect(await UploadsService.get(avatarA)).toBeFalsy();
    await agentA.delete('/api/users/avatar').expect(200);
    expect(await UploadsService.get(next)).toBeFalsy();
    avatarA = null;
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });
});
