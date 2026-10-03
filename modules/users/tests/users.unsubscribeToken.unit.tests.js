/**
 * Unit tests — unsubscribeToken.js (#4162).
 *
 * Mocks `config/index.js` so these tests are independent of the real
 * `config.jwt.secret` value, then re-imports the module fresh per test file
 * run (same pattern as `lib/helpers/tests/redactUrl.unit.tests.js`'s config
 * sourcing tests).
 */
import { jest, describe, test, expect, beforeAll } from '@jest/globals';

let createUnsubscribeToken;
let verifyUnsubscribeToken;

beforeAll(async () => {
  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: { jwt: { secret: 'test-unsubscribe-secret' } },
  }));
  ({ createUnsubscribeToken, verifyUnsubscribeToken } = await import('../utils/unsubscribeToken.js'));
});

describe('unsubscribeToken', () => {
  test('a freshly created token verifies back to the same userId and kind', () => {
    const token = createUnsubscribeToken('64b2f0000000000000000abc', 'news');
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: '64b2f0000000000000000abc', kind: 'news' });
  });

  test('two different kinds for the same user produce different signatures (domain separation)', () => {
    const newsToken = createUnsubscribeToken('64b2f0000000000000000abc', 'news');
    const onboardingToken = createUnsubscribeToken('64b2f0000000000000000abc', 'onboarding');
    expect(newsToken).not.toBe(onboardingToken);
    // and neither verifies as the other kind
    expect(verifyUnsubscribeToken(newsToken)).toEqual({ userId: '64b2f0000000000000000abc', kind: 'news' });
    expect(verifyUnsubscribeToken(onboardingToken)).toEqual({ userId: '64b2f0000000000000000abc', kind: 'onboarding' });
  });

  test('two different users produce different signatures for the same kind', () => {
    const tokenA = createUnsubscribeToken('64b2f0000000000000000aaa', 'news');
    const tokenB = createUnsubscribeToken('64b2f0000000000000000bbb', 'news');
    expect(tokenA).not.toBe(tokenB);
  });

  test('rejects a token whose kind was swapped without re-signing (signature no longer matches)', () => {
    const token = createUnsubscribeToken('64b2f0000000000000000abc', 'news');
    const [userId, , sig] = token.split('.');
    const tampered = `${userId}.onboarding.${sig}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  test('rejects a token whose userId was swapped without re-signing', () => {
    const token = createUnsubscribeToken('64b2f0000000000000000abc', 'news');
    const [, kind, sig] = token.split('.');
    const tampered = `64b2f0000000000000000bad.${kind}.${sig}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  test('rejects a token with a flipped signature byte', () => {
    const token = createUnsubscribeToken('64b2f0000000000000000abc', 'news');
    const [userId, kind, sig] = token.split('.');
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    expect(verifyUnsubscribeToken(`${userId}.${kind}.${flipped}`)).toBeNull();
  });

  test('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('not-a-token')).toBeNull();
    expect(verifyUnsubscribeToken('only.two')).toBeNull();
    expect(verifyUnsubscribeToken('way.too.many.parts.here')).toBeNull();
    expect(verifyUnsubscribeToken('..')).toBeNull();
    expect(verifyUnsubscribeToken('a.b.')).toBeNull();
  });

  test('rejects a non-hex signature without throwing', () => {
    expect(verifyUnsubscribeToken('64b2f0000000000000000abc.news.not-hex-at-all')).toBeNull();
  });

  test('is tolerant of non-string / nullish input', () => {
    expect(verifyUnsubscribeToken(undefined)).toBeNull();
    expect(verifyUnsubscribeToken(null)).toBeNull();
    expect(verifyUnsubscribeToken(42)).toBeNull();
    expect(verifyUnsubscribeToken({})).toBeNull();
  });
});
