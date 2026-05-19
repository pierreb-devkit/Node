/**
 * Email-domain normalization helpers.
 *
 * Maintained constant. Not auto-refreshed (spec H2 — freshness out of scope).
 */

export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'aol.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com',
]);

/**
 * Extract and normalize the domain portion of an email address.
 * @param {*} email - Raw value to parse.
 * @returns {string|null} Lowercased, trimmed domain, or null on malformed input.
 */
export function normalizeEmailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && domain.includes('.') ? domain : null;
}

/**
 * Return true when the domain belongs to a known public e-mail provider.
 * @param {string} domain - Normalized or raw domain string.
 * @returns {boolean}
 */
export function isPublicDomain(domain) {
  return PUBLIC_DOMAINS.has(String(domain ?? '').trim().toLowerCase());
}
