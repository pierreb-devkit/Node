# Mailer customization guide

`lib/helpers/mailer/index.js` renders a handlebars template to HTML and sends
it through a provider (`nodemailer` or `resend`, picked by
`config.mailer.provider`). Every shared Devkit mail — and any mail a
downstream project adds — goes through the same three independent
customization levels, from broadest to narrowest:

1. **`mailer.brand`** — the values every mail shares (name, logo, colors, a
   sign-off). No template to touch.
2. **`mailer.layout` / `mailer.partials`** — the HTML shell every mail body
   renders inside, and its four building blocks (header, footer, button,
   styles).
3. **`mailer.templates`** — a single mail's body.

A fourth mode, **legacy full-document passthrough**, lets a project ship a
mail that is already a complete HTML document: it skips the `mailer.layout`/
`mailer.partials` shell (Level 2) — no automatic header/footer/button — while
still receiving `brand`, `appName`, and `appContact` through `render()`'s
params, for the template to use itself if it wants them.

Read `lib/helpers/mailer/brand.js`, `layout.js`, `paths.js` and `index.js`
for the implementation — this guide follows what they actually do.

## Namespace rule

Devkit owns every file directly under `config/templates/` (the 15 shared
mails) and every `config/templates/_*/` folder (`_layout/` today — the
default layout + its partials). **A downstream project's own templates —
new ones, or a customized copy of a shared one — always go under
`config/templates/<project>/`**, reached through a `mailer.templates` entry
(Level 3 below), never dropped straight into the flat folder.

Two reasons this matters, not just style:

- `render()` sanitizes a template **key** to its `path.basename()` before
  resolving it — so you can't reach a subfolder by renaming the call site
  (`template: 'myproject/welcome'` still resolves to a file named
  `myproject/welcome`, which `path.basename` reduces to `welcome`). The only
  way to point a key at a file outside the flat folder is a `mailer.templates`
  map entry, whose *value* (not the key) carries the real path.
- `config/templates/*.html` is `/update-stack`'s ISO-merge scope, the same as
  `modules/` and `lib/` — a file you add straight into the flat folder is
  fine until Devkit ships a file with that same name, at which point the next
  ISO merge treats it as Devkit's and overwrites it.

## Level 1 — `mailer.brand`

`getBrand()` (`brand.js`) resolves one brand object, merged into every
render. Three fields fall back to existing app config so the legacy
`appName`/`appContact` params resolve to the same values as before
`mailer.brand` existed — but the shared mails' rendered HTML did change (new
layout shell, new footer; see `MIGRATIONS.md`) even with an unconfigured
brand. The rest have no fallback — they render only when set:

| Field | Fallback | Rendered by |
|---|---|---|
| `name` | `config.app.title` | header (as text, or `alt` on the logo), and the legacy `appName` param (below) |
| `url` | `config.app.url`, then `getBaseUrl()` | footer, as a plain link |
| `contact` | `config.app.contact` | footer, as a `mailto:` link, and the legacy `appContact` param (below) |
| `logoUrl` | — | header (replaces the text name when set) |
| `primaryColor` | — | the button partial's background, and the footer's link color |
| `textColor` | — | the layout's email-shell text color |
| `fontFamily` | — | the layout's email-shell font |
| `signature` | — | footer, first line (the old per-template sign-off) |
| `footerText` | — | footer, second line |
| `mutedColor` | — | not used by any shipped partial — reserved for a project that ships its own `mailer.layout`/`mailer.partials` (Level 2) |
| `links` | `{}` | footer, one link per `{ label: url }` entry |

```js
// config/defaults/<project>.config.js — same shape as
// lib/helpers/mailer/tests/mailer.brand.unit.tests.js
export default {
  mailer: {
    brand: {
      name: 'Rocket',
      url: 'https://rocket.example',
      contact: 'support@rocket.example',
      logoUrl: 'https://rocket.example/logo.png',
      primaryColor: '#112233',
      textColor: '#ffffff',
      mutedColor: '#999999',
      fontFamily: 'Helvetica, sans-serif',
      signature: 'The Rocket Team',
      footerText: 'Rocket Inc.',
      links: { Pricing: 'https://rocket.example/pricing' },
    },
  },
};
```

Every scalar field is also settable individually via
`DEVKIT_NODE_mailer_brand_<field>` (e.g. `DEVKIT_NODE_mailer_brand_primaryColor`),
same as any other config key. `links` is an object, not a scalar — one env
var can't set it; an env var always delivers a string, which fails
`getBrand()`'s plain-object check and falls back to `{}` (configure `links`
from a `config/defaults/<project>.config.js` file instead).

**Legacy `appName`/`appContact`:** every render also receives `appName` (=
`brand.name`) and `appContact` (= `brand.contact`) as plain params, for
templates written before `brand` existed. Brand wins over a caller-passed
`appName`/`appContact`/`brand` — those three keys only; every other param
the caller passes through `mail.params` reaches the template untouched.

## Level 2 — `mailer.layout` and `mailer.partials`

Any template that isn't a full HTML document (see Level 4) is a **body
fragment**: it's compiled on its own, then wrapped inside `mailer.layout`
(default `config/templates/_layout/layout.html`), which also pulls in four
named partials (default `config/templates/_layout/{header,footer,button,styles}.html`):

```js
export default {
  mailer: {
    layout: 'config/templates/myproject/layout.html', // falls back to Devkit's own when unset or ''
    partials: {
      header: 'config/templates/myproject/header.html', // override one, or several — the rest keep Devkit's default
    },
  },
};
```

Both paths go through the same containment check (`paths.js`): relative,
`.html`, and resolved inside the project root — an absolute path, a `../`
escape, or any other extension throws, naming the offending config key.

The layout's own render context is **not** the template's: it receives
exactly `body` (the compiled fragment, the only unescaped slot), `brand`,
`subject` (fills `<title>`), and an explicit allow-list of two link params —
`emailSettingsUrl`, `unsubscribeUrl` — lifted from the caller's `params`.
Nothing else from `mail.params` reaches the layout or its partials; a footer
that wants a third, per-mail/per-recipient link needs that key added to the
allow-list in `index.js` — a Devkit stack change (`lib/` is ISO-merge scope,
so a downstream edit there is overwritten on the next `/update-stack`), not
something a downstream project edits directly. A downstream wanting extra
footer links that are the same on every mail adds them through `brand.links`
(Level 1) instead, one `{ label: url }` entry at a time.

The `button` partial takes its own hash args from the invoking template,
not the layout context — the pattern every shared template uses:

```handlebars
{{> button url=url label="Get started"}}
```

Overriding `mailer.partials.button` without matching this call shape (a
`url` and a `label`) breaks every template that invokes it.

## Level 3 — `mailer.templates`

```js
export default {
  mailer: {
    templates: {
      // key → project-owned relative .html path, same containment rule as Level 2
      welcome: 'config/templates/myproject/welcome.html',
    },
  },
};
```

Resolution for a given key (`resolveTemplatePath()` in `index.js`): a
`mailer.templates` entry wins; anything else falls back to
`config/templates/<key>.html` — today's behavior, so a template that only
ever existed in a downstream project (never one of the 15 shared mails)
keeps resolving with no config at all. That flat-fallback path is what
customizing a **shared** template in place would silently rely on too,
which is exactly what the namespace rule above says not to do.

## Level 4 — legacy full-document passthrough

A template whose source starts with `<!doctype` or `<html` (case-insensitive,
leading whitespace allowed) is detected as a complete document and sent
**unwrapped** — no layout, no partials, no brand-driven header/footer. It's
compiled on its own pristine handlebars instance, so it can't use
`{{> header}}`/`{{> footer}}`/`{{> button}}` (those are only registered on
the fragment/layout render path) — a legacy document that tries throws.
None of the 15 shared Devkit mails use this path any more; it exists for a
project that wants to ship its own, fully self-designed HTML email outside
the shared layout.

## Sender display name

`mailer.from` (and a per-send `mail.from` override) is forwarded to the
provider as-is — Devkit never parses it. Both providers accept the standard
`"Name" <address>` RFC 5322 form, e.g.:

```js
mailer: { from: 'Rocket <hello@rocket.example>' },
```

(see `modules/users/crons/README.md` for the same pattern on a per-sequence
`from` override).

## Product-email params for a custom layout/partials

A product email sent through `sendProductMail`/`announce` carries two link
params into the layout context — `emailSettingsUrl` (the frontend's account
page) and `unsubscribeUrl` (the one-click unsubscribe token link). The
*default* footer partial renders only `emailSettingsUrl`, as an "Email
settings" link, when present. `unsubscribeUrl` reaches the layout context
too (a custom `mailer.partials.footer` may render it), but nothing renders
it by default — it surfaces instead as the `List-Unsubscribe` header, and
only when the resolved URL is HTTPS. A project that ships its own
`mailer.partials.footer` (Level 2) and wants to render `unsubscribeUrl`
itself only needs `{{unsubscribeUrl}}` in its template — it already reaches
the layout context unconditionally (the allow-list in Level 2). For what
each link resolves to, who gets it, and the opt-out mechanics, see
`modules/users/doc/guides/02-email-preferences.md` — not duplicated here.

## Migrating a template

A project-only template (Level 3's fallback) needs no migration — Devkit's
ISO merge never touches a filename it doesn't ship. **Converting a shared
template you'd edited in place**, or any other breaking change to the 15
shared mails, is dated in `MIGRATIONS.md` ("mailer: the 15 shared
`config/templates/*.html` mails are now body fragments on the default
layout" and the entry just below it) — including the move-to-`<project>/`
-and-restore recipe, and that a shared mail's rendered HTML now looks
different (new `<head>`/outer table, old sign-offs replaced by `brand.*`)
even when nothing in your config changed.
