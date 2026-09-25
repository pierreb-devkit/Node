/**
 * Module dependencies
 */
import config from '../../config/index.js';
import logger from '../../lib/services/logger.js';
import billingEvents from './lib/events.js';
import mailer from '../../lib/helpers/mailer/index.js';
import MembershipRepository from '../organizations/repositories/organizations.membership.repository.js';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from '../organizations/lib/constants.js';

/**
 * Resolve owner/admin emails for an organization.
 * Returns an array of email strings (may be empty if none found or lookup fails).
 * @param {string} organizationId
 * @returns {Promise<string[]>}
 */
export const resolveOrgAdminEmails = async (organizationId) => {
  try {
    const memberships = await MembershipRepository.list({
      organizationId,
      role: { $in: [MEMBERSHIP_ROLES.OWNER, MEMBERSHIP_ROLES.ADMIN] },
      status: MEMBERSHIP_STATUSES.ACTIVE,
    });
    return memberships.map((m) => m.userId?.email).filter(Boolean);
  } catch (err) {
    logger.warn('[billing.email] resolveOrgAdminEmails failed (non-fatal)', {
      organizationId,
      error: err?.message ?? err,
    });
    return [];
  }
};

/**
 * Fire-and-forget email send. Logs mailer errors without re-throwing.
 * @param {Object} mailOpts - Options passed directly to mailer.sendMail
 * @param {string} context  - Log prefix for error messages
 */
export const sendBillingEmail = (mailOpts, context) => {
  if (!mailer.isConfigured()) return;
  mailer.sendMail(mailOpts).catch((err) => {
    logger.error(`[billing.email] ${context} email failed`, {
      error: err?.message ?? err,
      stack: err?.stack,
    });
  });
};

/**
 * Wire billing email listeners onto billingEvents.
 * Call once from billing.init.js after config is ready.
 *
 * Listeners registered:
 *  - meter.threshold_crossed              — sends 80% warning or 100% quota-reached email to org admins/owners
 *  - billing.extras.balance_threshold_crossed — sends a credit-warning or credit-exhausted email
 *    (one-shot signup-grant plans, no weekly quota — see README.md § Credit-balance alerts)
 *  - payment.failed                       — sends payment-failed email prompting card update
 *
 * Template resolution: devkit ships generic templates in config/templates/billing-*.html.
 * Downstream projects override by placing same-named files in their own config/templates/
 * directory — those shadow devkit defaults via the template-resolution glob-merge in config.
 */
export const setupBillingEmails = () => {
  // ── meter.threshold_crossed — 80% / 100% quota emails ──────────────────────

  billingEvents.on('meter.threshold_crossed', ({ organizationId, threshold, meterUsed, meterQuota }) => {
    if (threshold !== 80 && threshold !== 100) return;

    const appName = config.app?.title ?? '';
    const billingUrl = config.app?.url ? `${config.app.url}/billing` : '';

    resolveOrgAdminEmails(organizationId).then((emails) => {
      if (!emails.length) return;
      const isAt80 = threshold === 80;
      for (const email of emails) {
        sendBillingEmail(
          {
            to: email,
            subject: isAt80
              ? `Approaching your ${appName} quota — ${threshold}% used`
              : `${appName} weekly quota reached`,
            template: isAt80 ? 'billing-quota-warning-80' : 'billing-quota-reached-100',
            params: {
              threshold,
              meterUsed: meterUsed ?? '?',
              meterQuota: meterQuota ?? '?',
              billingUrl,
              appName,
              appContact: config.app?.contact ?? '',
            },
          },
          isAt80 ? 'meter.threshold_crossed@80' : 'meter.threshold_crossed@100',
        );
      }
    });
  });

  // ── billing.extras.balance_threshold_crossed — credit-balance alerts (#4117) ──
  // One-shot signup-grant plans (no weekly quota): 80%-consumed warning or fully-out
  // email. Copy speaks in absolute credits left, never "% of grant" — a pack or
  // referral top-up can raise the balance again, at which point "% of grant" is
  // meaningless (see README.md § Credit-balance alerts). No org name in the copy.

  billingEvents.on('billing.extras.balance_threshold_crossed', ({ organizationId, threshold, remaining }) => {
    if (threshold !== 80 && threshold !== 100) return;

    const appName = config.app?.title ?? '';
    const billingUrl = config.app?.url ? `${config.app.url}/billing` : '';
    const isWarning = threshold === 80;

    resolveOrgAdminEmails(organizationId).then((emails) => {
      if (!emails.length) return;
      for (const email of emails) {
        sendBillingEmail(
          {
            to: email,
            subject: isWarning
              ? `${appName} — your credits are running low`
              : `${appName} — you are out of credits`,
            template: isWarning ? 'billing-credit-warning' : 'billing-credit-exhausted',
            params: {
              remaining: remaining ?? 0,
              billingUrl,
              appName,
              appContact: config.app?.contact ?? '',
            },
          },
          isWarning ? 'billing.extras.balance_threshold_crossed@80' : 'billing.extras.balance_threshold_crossed@100',
        );
      }
    });
  });

  // ── payment.failed — update card prompt ─────────────────────────────────────

  billingEvents.on('payment.failed', ({ organizationId }) => {
    const appName = config.app?.title ?? '';
    const billingPortalUrl = config.app?.url ? `${config.app.url}/billing` : '';

    resolveOrgAdminEmails(organizationId).then((emails) => {
      if (!emails.length) return;
      for (const email of emails) {
        sendBillingEmail(
          {
            to: email,
            subject: `${appName} billing — please update your payment method`,
            template: 'billing-payment-failed',
            params: {
              billingPortalUrl,
              appName,
              appContact: config.app?.contact ?? '',
            },
          },
          'payment.failed',
        );
      }
    });
  });
};
