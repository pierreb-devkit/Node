/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';
import { encodeReferralCode } from '../../users/lib/users.referralCode.js';

const run = promisify(execFile);

/**
 * Referral reconcile cron — REAL script run (#4214). Spawns
 * `modules/billing/crons/billing.referralReconcile.js` as a child process against the
 * test database (the script owns process.exit and the Mongo connection, so it cannot be
 * imported in-process) with the link flag / cap set by a tiny wrapper, then asserts the
 * ledger: a missed link grant is back-filled, a referrer past the cap is not, a missing
 * cap grants nothing, and a re-run is idempotent.
 */
describe('Billing referral reconcile cron — link signups (#4214):', () => {
  let app;
  let UserService;
  let BillingExtraBalanceRepository;
  let referrerId;
  let originalReferral;

  const PASSWORD = 'W@os.jsI$Aw3$0m3';
  const emails = {
    referrer: 'ref-cron-referrer@test.com',
    one: 'ref-cron-one@test.com',
    two: 'ref-cron-two@test.com',
    three: 'ref-cron-three@test.com',
  };

  const signup = (email, extra = {}) => request(app).post('/api/auth/signup').send({
    firstName: 'Ref', lastName: 'Cron', email, password: PASSWORD, provider: 'local', ...extra,
  });

  /**
   * Run the real reconcile script with the link flag on and the given cap.
   * @param {number|null} maxLifetime - invitations.maxLifetime for the child process.
   * @returns {Promise<void>} resolves when the script exits 0 (execFile rejects otherwise)
   */
  const runCron = (maxLifetime) => {
    const wrapper = `
      const { default: config } = await import('./config/index.js');
      config.db.uri = process.env.CRON_TEST_DB_URI;
      config.billing.referral = { ...config.billing.referral, enabled: true, link: true, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 };
      config.billing.crons = { ...(config.billing.crons ?? {}), jitterMaxMs: 0 };
      config.invitations = { ...config.invitations, maxLifetime: ${JSON.stringify(maxLifetime)} };
      await import('./modules/billing/crons/billing.referralReconcile.js');
    `;
    return run(process.execPath, ['--input-type=module', '-e', wrapper], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', CRON_TEST_DB_URI: config.db.uri },
      timeout: 60000,
    });
  };

  const hasKey = async (key) => (await BillingExtraBalanceRepository.findExistingRefIds([key])).length === 1;

  const cleanupUsers = async () => {
    for (const email of Object.values(emails)) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
    }
  };

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    BillingExtraBalanceRepository = (await import(path.resolve('./modules/billing/repositories/billing.extraBalance.repository.js'))).default;
    originalReferral = config.billing.referral;
    // Link OFF while signing up: the three referred users are "missed" link signups.
    config.billing.referral = { enabled: true, link: false, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 };
    await cleanupUsers();
    await signup(emails.referrer).expect(200);
    const referrer = await UserService.getBrut({ email: emails.referrer });
    referrerId = String(referrer._id);
    for (const key of ['one', 'two', 'three']) {
      await signup(emails[key], { ref: encodeReferralCode(referrerId) }).expect(200);
    }
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }, 60000);

  afterAll(async () => {
    config.billing.referral = originalReferral;
    await cleanupUsers();
  });

  test('without a usable cap the cron grants no link reward; with cap 2 it back-fills only the first two (by id), and a re-run changes nothing', async () => {
    const ids = [];
    for (const key of ['one', 'two', 'three']) ids.push(String((await UserService.getBrut({ email: emails[key] }))._id));
    ids.sort();
    const referee = (id) => `referral:link:${id}:referee`;
    const referrer = (id) => `referral:link:${id}:referrer:${referrerId}`;

    await runCron(null);
    for (const id of ids) expect(await hasKey(referee(id))).toBe(false);

    await runCron(2);
    expect(await hasKey(referee(ids[0]))).toBe(true);
    expect(await hasKey(referrer(ids[0]))).toBe(true);
    expect(await hasKey(referee(ids[1]))).toBe(true);
    expect(await hasKey(referrer(ids[1]))).toBe(true);
    expect(await hasKey(referee(ids[2]))).toBe(false);
    expect(await hasKey(referrer(ids[2]))).toBe(false);
    expect(await BillingExtraBalanceRepository.countLinkReferrerGrants(referrerId)).toBe(2);

    await runCron(2);
    expect(await BillingExtraBalanceRepository.countLinkReferrerGrants(referrerId)).toBe(2);
    expect(await hasKey(referee(ids[2]))).toBe(false);
  }, 120000);
});
