import Transport from 'winston-transport';
import errorTracker from './errorTracker.js';

/**
 * Winston transport that forwards `error`-level (and above) logs to
 * PostHog Error Tracking via the existing errorTracker service.
 *
 * Dedup with the Express 4-arg error middleware: errors that have
 * already been captured (marked `err.posthogCaptured = true` by
 * `errorTracker.setupExpressErrorHandler`) are skipped so the same
 * exception doesn't land twice in PostHog.
 *
 * Safe-by-default: the transport's `log()` swallows any throw from
 * the underlying capture call so application logging never breaks
 * when PostHog is misconfigured or unreachable.
 */
export class PostHogErrorTransport extends Transport {
  constructor(opts = {}) {
    super({ ...opts, level: opts.level ?? 'error' });
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    const sourceErr = info instanceof Error
      ? info
      : info?.error instanceof Error
        ? info.error
        : null;

    if (sourceErr?.posthogCaptured) {
      callback();
      return;
    }

    const err = sourceErr ?? Object.assign(
      new Error(info?.message ?? 'logger.error'),
      info?.stack ? { stack: info.stack } : {},
    );

    try {
      errorTracker.captureException(err, {
        distinctId: info?.distinctId,
        requestId: info?.requestId,
        properties: {
          source: 'system',
          logMessage: info?.message,
          logLevel: info?.level,
        },
      });
      if (sourceErr) sourceErr.posthogCaptured = true;
    } catch (_) { /* logging must never break the caller */ }

    callback();
  }
}

export default PostHogErrorTransport;
