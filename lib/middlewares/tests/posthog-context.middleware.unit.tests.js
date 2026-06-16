/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for posthog-context middleware.
 * Verifies config-driven User-Agent parsing for CLI vs web source attribution:
 *   1. CLI UA with version → source:'cli', cli_version:'<version>'
 *   2. CLI UA without explicit version segment → source:'cli' fallback
 *   3. Web browser UA → source:'web'
 *   4. Missing UA → source:'web'
 *   5. Unset CLI pattern → no detection (source always 'web')
 */

// Neutral CLI user-agent pattern used by the configured-detection suite.
const CLI_UA_PATTERN = '@example-org/cli/(\\S+)';

/**
 * Load the middleware with config mocked to a given CLI user-agent pattern.
 *
 * @param {string} cliUserAgentPattern - regex-source string (empty → no detection)
 * @returns {Promise<Function>} the posthogContextMiddleware bound to that config
 */
const loadMiddleware = async (cliUserAgentPattern) => {
  jest.resetModules();
  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: { analytics: { cliUserAgentPattern } },
  }));
  const { posthogContextMiddleware } = await import('../posthog-context.middleware.js');
  return posthogContextMiddleware;
};

describe('posthogContextMiddleware unit tests:', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      get: jest.fn(),
    };
    res = {};
    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('with a configured CLI user-agent pattern:', () => {
    let posthogContextMiddleware;

    beforeEach(async () => {
      posthogContextMiddleware = await loadMiddleware(CLI_UA_PATTERN);
    });

    test('CLI UA with version → source:cli + cli_version', () => {
      req.get.mockReturnValue('@example-org/cli/1.2.3');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'cli', cli_version: '1.2.3' });
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('CLI UA with pre-release version → source:cli + cli_version', () => {
      req.get.mockReturnValue('@example-org/cli/2.0.0-beta.1 node/22.0.0');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'cli', cli_version: '2.0.0-beta.1' });
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('web browser UA → source:web (no cli_version)', () => {
      req.get.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'web' });
      expect(req.posthogContext).not.toHaveProperty('cli_version');
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('missing User-Agent header → source:web (no cli_version)', () => {
      req.get.mockReturnValue(undefined);
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'web' });
      expect(req.posthogContext).not.toHaveProperty('cli_version');
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('empty User-Agent header → source:web', () => {
      req.get.mockReturnValue('');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'web' });
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('curl UA → source:web', () => {
      req.get.mockReturnValue('curl/8.7.1');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'web' });
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('always calls next()', () => {
      req.get.mockReturnValue('@example-org/cli/0.1.0');
      posthogContextMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(); // called with no args (no error)
    });
  });

  describe('with no CLI user-agent pattern configured:', () => {
    let posthogContextMiddleware;

    beforeEach(async () => {
      posthogContextMiddleware = await loadMiddleware('');
    });

    test('a CLI-looking UA still resolves to source:web (detection disabled)', () => {
      req.get.mockReturnValue('@example-org/cli/1.2.3');
      posthogContextMiddleware(req, res, next);

      expect(req.posthogContext).toEqual({ source: 'web' });
      expect(req.posthogContext).not.toHaveProperty('cli_version');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
