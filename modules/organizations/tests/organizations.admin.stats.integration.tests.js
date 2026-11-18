/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests — GET /api/admin/organizations/stats (admin stats)
 */
describe('organizations admin stats integration tests:', () => {
  let UserService;
  let app;
  const created = [];

  const signup = async (agent, email) => {
    const res = await agent
      .post('/api/auth/signup')
      .send({ firstName: 'Stats', lastName: 'Test', email, password: 'W@os.jsI$Aw3$0m3', provider: 'local' })
      .expect(200);
    created.push(res.body.user);
    return res.body.user;
  };

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
  });

  test('should reject an unauthenticated request', async () => {
    await request(app).get('/api/admin/organizations/stats').expect(401);
  });

  test('should reject a non-admin user', async () => {
    const agent = request.agent(app);
    await signup(agent, 'stats-user-organizations@test.com');
    await agent.get('/api/admin/organizations/stats').expect(403);
  });

  test('should return the stats to an admin', async () => {
    const agent = request.agent(app);
    const user = await signup(agent, 'stats-admin-organizations@test.com');
    const brut = await UserService.getBrut({ id: user.id || user._id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');

    const res = await agent.get('/api/admin/organizations/stats').expect(200);
    expect(res.body.type).toBe('success');
    expect(res.body.message).toBe('organization stats');
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.data.weeks).toHaveLength(12);
    expect(res.body.data.weeks.every((w) => Number.isInteger(w.count))).toBe(true);
  });

  afterAll(async () => {
    for (const user of created) {
      try {
        await UserService.remove(user);
      } catch (_) { /* cleanup – ignore errors */ }
    }
    await mongooseService.disconnect();
  });
});
