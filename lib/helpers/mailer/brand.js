import config from '../../../config/index.js';
import getBaseUrl from '../getBaseUrl.js';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @desc Resolve the single source of truth for mail brand values.
 *   `config.mailer.brand` wins field-by-field; unset fields fall back:
 *   - `name` falls back to `config.app.title`
 *   - `url` falls back to `config.app.url`, then `getBaseUrl()`
 *   - `contact` falls back to `config.app.contact`
 *   Every other field (`logoUrl`, `primaryColor`, `textColor`, `mutedColor`,
 *   `fontFamily`, `signature`, `footerText`) has no fallback — undefined
 *   when not configured. `links` is a `{ label: url }` object, `{}` by
 *   default; a configured `links` that isn't a plain object (e.g. a string,
 *   because an env var always delivers one) also falls back to `{}` rather
 *   than reaching a template's `{{#each brand.links}}`.
 * @returns {{
 *   name: string|undefined,
 *   url: string,
 *   contact: string|undefined,
 *   logoUrl: string|undefined,
 *   primaryColor: string|undefined,
 *   textColor: string|undefined,
 *   mutedColor: string|undefined,
 *   fontFamily: string|undefined,
 *   signature: string|undefined,
 *   footerText: string|undefined,
 *   links: Object<string, string>,
 * }} The resolved brand values
 */
const getBrand = () => {
  const raw = config.mailer?.brand || {};
  return {
    name: raw.name ?? config.app?.title,
    url: raw.url ?? config.app?.url ?? getBaseUrl(),
    contact: raw.contact ?? config.app?.contact,
    logoUrl: raw.logoUrl,
    primaryColor: raw.primaryColor,
    textColor: raw.textColor,
    mutedColor: raw.mutedColor,
    fontFamily: raw.fontFamily,
    signature: raw.signature,
    footerText: raw.footerText,
    links: isPlainObject(raw.links) ? raw.links : {},
  };
};

export default getBrand;
