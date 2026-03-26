/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { afterAll, beforeAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Integration tests
 */
describe('Audit integration tests:', () => {
  let UserService;
  let AuditService;
  let agent;
  let adminAgent;
  let adminUser;
  let regularUser;
  const originalOrgEnabled = config.organizations?.enabled;

  beforeAll(async () => {
    // Disable organizations so signup auto-creates a silent org with membership
    if (config.organizations) config.organizations.enabled = false;
    // Ensure audit is enabled for tests
    if (!config.audit) config.audit = {};
    config.audit.enabled = true;

    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      AuditService = (await import(path.resolve('./modules/audit/services/audit.service.js'))).default;
      agent = request.agent(init.app);
      adminAgent = request.agent(init.app);

      // Create regular user on regular agent
      const userResult = await agent.post('/api/auth/signup').send({
        firstName: 'Audit',
        lastName: 'Regular',
        email: 'auditregular@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      }).expect(200);
      regularUser = userResult.body.user;

      // Create admin user on admin agent
      const adminResult = await adminAgent.post('/api/auth/signup').send({
        firstName: 'Audit',
        lastName: 'Admin',
        email: 'auditadmin@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
      }).expect(200);
      adminUser = adminResult.body.user;

      // Elevate to admin role
      const brutUser = await UserService.getBrut({ id: adminUser.id });
      await UserService.update(brutUser, { roles: ['user', 'admin'] }, 'admin');

      // Re-login admin to refresh JWT with admin role awareness
      await adminAgent.post('/api/auth/signin').send({
        email: 'auditadmin@test.com',
        password: 'W@os.jsI$Aw3$0m3',
      }).expect(200);

      // Create some audit entries
      await AuditService.log({
        action: 'auth.login',
        req: { user: { _id: adminUser.id }, headers: { 'user-agent': 'test' } },
        targetType: 'User',
        targetId: adminUser.id,
      });
      await AuditService.log({
        action: 'auth.signup',
        req: { user: { _id: adminUser.id }, headers: { 'user-agent': 'test' } },
        targetType: 'User',
        targetId: adminUser.id,
      });
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  afterAll(async () => {
    try {
      if (adminUser) await UserService.remove(adminUser);
      if (regularUser) await UserService.remove(regularUser);
      if (config.organizations) config.organizations.enabled = originalOrgEnabled;
    } catch (_) { /* best-effort cleanup */ }
    await mongooseService.disconnect();
  });

  test('should deny audit log access to non-admin', async () => {
    const result = await agent.get('/api/audit').expect(403);
    expect(result.body.type).toBe('error');
  });

  test('should return paginated audit logs for admin', async () => {
    const result = await adminAgent.get('/api/audit').expect(200);
    expect(result.body.type).toBe('success');
    expect(result.body.data).toBeDefined();
    expect(result.body.data.data).toBeInstanceOf(Array);
    expect(result.body.data.total).toBeGreaterThanOrEqual(2);
    expect(result.body.data.page).toBe(1);
    expect(result.body.data.perPage).toBe(20);
  });

  test('should filter audit logs by action', async () => {
    const result = await adminAgent.get('/api/audit?action=auth.login').expect(200);
    expect(result.body.data.data.length).toBeGreaterThanOrEqual(1);
    result.body.data.data.forEach((entry) => {
      expect(entry.action).toBe('auth.login');
    });
  });

  test('should respect pagination params', async () => {
    const result = await adminAgent.get('/api/audit?page=1&perPage=1').expect(200);
    expect(result.body.data.data.length).toBeLessThanOrEqual(1);
    expect(result.body.data.perPage).toBe(1);
  });
});
