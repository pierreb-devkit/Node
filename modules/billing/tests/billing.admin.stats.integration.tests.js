/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests — GET /api/admin/billing/stats (admin stats)
 */
describe('billing admin stats integration tests:', () => {
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
    await request(app).get('/api/admin/billing/stats').expect(401);
  });

  test('should reject a non-admin user', async () => {
    const agent = request.agent(app);
    await signup(agent, 'stats-user-billing@test.com');
    await agent.get('/api/admin/billing/stats').expect(403);
  });

  test('should return the stats to an admin', async () => {
    const agent = request.agent(app);
    const user = await signup(agent, 'stats-admin-billing@test.com');
    const brut = await UserService.getBrut({ id: user.id || user._id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');

    const res = await agent.get('/api/admin/billing/stats').expect(200);
    expect(res.body.type).toBe('success');
    expect(res.body.message).toBe('billing stats');
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.data.byPlan).toBeInstanceOf(Object);
    expect(res.body.data.byStatus).toBeInstanceOf(Object);
    const planSum = Object.values(res.body.data.byPlan).reduce((a, b) => a + b, 0);
    expect(planSum).toBe(res.body.data.total);
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
