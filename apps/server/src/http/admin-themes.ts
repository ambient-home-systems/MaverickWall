import type { Context, Hono } from 'hono';
import { escapeHtml, errorBlock, page, selectField, textField } from './html.js';
import { navModules, type AdminDeps } from './admin.js';
import {
  COLOUR_TOKENS,
  createTheme,
  deleteTheme,
  FONTS,
  FONT_TOKENS,
  readTheme,
  readThemes,
  themeTokensSchema,
  updateTheme,
  type ThemeRow,
  type ThemeTokens,
} from '../api/themes.js';
import { colour, oneOf, parse, text } from '../validation.js';
import { generateThemeTokens } from '../api/theme-generator.js';
import { readSaved, savedRedirect } from './saved.js';

/**
 * The custom-theme builder (system settings).
 *
 * The four built-in directions live in the display bundle as code; this screen
 * is where a household builds its own. The form is server-rendered and saves
 * with a plain POST — it works with no scripting — and `assets/theme-editor.js`
 * enhances it with a live preview and contrast guidance. A custom theme is
 * selectable on the Displays screen exactly like a built-in.
 */

/** A new theme starts from Board's palette — a known-legible dark default. */
const DEFAULT_TOKENS: ThemeTokens = {
  '--bg': '#0B0E11',
  '--panel': '#151A21',
  '--rule': '#242D38',
  '--ink': '#E9EEF4',
  '--muted': '#7E8C9C',
  '--faint': '#4A5563',
  '--accent': '#E8A33D',
  '--s-day': '#E8A33D',
  '--s-night': '#4C7FD1',
  '--s-break': '#35916A',
  '--s-straight': '#6B7684',
  '--radius': '0.2rem',
};

/** Each editable colour with the plain-language account of what it drives. */
const TOKEN_HELP: readonly { readonly key: string; readonly label: string; readonly help: string }[] = [
  { key: '--bg', label: 'Background', help: 'The wall behind everything.' },
  { key: '--panel', label: 'Panels', help: 'The surface of cards and the month grid.' },
  { key: '--rule', label: 'Lines', help: 'Hairline borders between things.' },
  { key: '--ink', label: 'Text', help: 'The main reading colour.' },
  { key: '--muted', label: 'Muted text', help: 'Secondary text — times and labels.' },
  { key: '--faint', label: 'Faint text', help: 'The quietest text — past days.' },
  { key: '--accent', label: 'Accent', help: 'Today, and highlights across the wall.' },
  { key: '--s-day', label: 'Day shift', help: 'The colour of a day shift.' },
  { key: '--s-night', label: 'Night shift', help: 'The colour of a night shift.' },
  { key: '--s-break', label: 'Rest day', help: 'A day the rota says is off.' },
  { key: '--s-straight', label: 'Other shift', help: 'Any other shift type.' },
];

const RADII: readonly { readonly value: string; readonly label: string }[] = [
  { value: '0', label: 'Sharp' },
  { value: '0.2rem', label: 'Subtle' },
  { value: '0.4rem', label: 'Soft' },
  { value: '1.2rem', label: 'Round' },
];

const nameBody = text('A name for the theme', 60);

/** Three representative colours for a swatch strip. */
function swatch(tokens: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [tokens['--bg'] ?? '#0B0E11', tokens['--accent'] ?? '#E8A33D', tokens['--s-night'] ?? '#4C7FD1'];
}

export function registerThemeRoutes(app: Hono, deps: AdminDeps): void {
  // ---- routes --------------------------------------------------------------

  app.get('/admin/themes', (c: Context) => c.html(themesPage(c)));

  app.get('/admin/themes/new', (c: Context) => c.html(builderPage(null, undefined, undefined, c)));

  app.get('/admin/themes/:id', (c: Context) => {
    const theme = readTheme(deps.db, c.req.param('id') ?? '');
    if (theme === undefined) return c.redirect('/admin/themes', 302);
    return c.html(builderPage(theme, undefined, undefined, c));
  });

  app.post('/admin/themes', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = shapeSubmission(body);
    if (!shaped.ok) return c.html(builderPage(null, body, shaped.message, c), 400);
    createTheme(deps.db, shaped.value);
    return savedRedirect(c, '/admin/themes', 'theme-created');
  });

  /**
   * Generate a full theme from one seed colour, then store it through the
   * exact create path a hand-built theme takes: the generator's output is
   * validated by the same schema (rule five — the generator is ours, but the
   * invariant is cheaper to prove than to trust), so the result is an
   * ordinary custom theme — previewable in the builder, editable afterwards,
   * resolved with tints and carried in the manifest like any other.
   */
  app.post('/admin/themes/generate', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = parse(nameBody, body['name']);
    if (!name.ok) return c.html(themesPage(c, name.message), 400);
    const seed = parse(colour(), body['seed']);
    if (!seed.ok) return c.html(themesPage(c, 'Pick a seed colour.'), 400);
    const mode = parse(oneOf('Dark or light', ['dark', 'light'] as const), body['mode']);
    if (!mode.ok) return c.html(themesPage(c, 'Choose dark or light.'), 400);

    const tokens = themeTokensSchema.parse(generateThemeTokens(seed.value, mode.value));
    const created = createTheme(deps.db, { name: name.value, tokens });
    // Land in the builder so the result is immediately previewable and editable.
    return savedRedirect(c, `/admin/themes/${encodeURIComponent(created.id)}`, 'theme-generated');
  });

  app.post('/admin/themes/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const existing = readTheme(deps.db, id);
    if (existing === undefined) return c.redirect('/admin/themes', 302);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = shapeSubmission(body);
    if (!shaped.ok) return c.html(builderPage(existing, body, shaped.message, c), 400);
    updateTheme(deps.db, id, shaped.value);
    return savedRedirect(c, '/admin/themes', 'theme-saved');
  });

  app.post('/admin/themes/:id/delete', (c: Context) => {
    deleteTheme(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/themes', 'theme-removed');
  });

  // ---- shaping -------------------------------------------------------------

  /** Pull the name and every colour token out of a form body, then validate. */
  function shapeSubmission(
    body: Record<string, unknown>,
  ): { ok: true; value: { name: string; tokens: ThemeTokens } } | { ok: false; message: string } {
    const name = parse(nameBody, body['name']);
    if (!name.ok) return { ok: false, message: name.message };

    const raw: Record<string, unknown> = {};
    for (const token of COLOUR_TOKENS) raw[token] = body[token];
    raw['--radius'] = body['radius'];
    // Fonts are optional: an empty select is "keep the default", so only a
    // chosen stack is carried into the token set.
    for (const token of FONT_TOKENS) {
      const value = body[token];
      if (typeof value === 'string' && value !== '') raw[token] = value;
    }

    const tokens = themeTokensSchema.safeParse(raw);
    if (!tokens.success) {
      return { ok: false, message: 'Every colour needs to be a valid swatch, and the corners a preset.' };
    }
    return { ok: true, value: { name: name.value, tokens: tokens.data } };
  }

  // ---- pages ---------------------------------------------------------------

  function themesPage(c: Context, error?: string): string {
    const custom = readThemes(deps.db);
    const card = (theme: ThemeRow): string =>
      `<article class="card">` +
      `<div style="display:flex;align-items:center;gap:12px">` +
      `<div class="sw" style="display:flex;width:66px;height:34px;border-radius:6px;overflow:hidden;flex:0 0 auto">` +
      swatch(theme.tokens).map((c) => `<i style="flex:1;background:${escapeHtml(c)}"></i>`).join('') +
      `</div>` +
      `<div class="rname" style="flex:1;font-size:16px">${escapeHtml(theme.name)}</div></div>` +
      `<div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--ruleSoft)">` +
      `<a class="btn btn-sm" href="admin/themes/${encodeURIComponent(theme.id)}">Edit</a>` +
      `<form method="post" action="admin/themes/${encodeURIComponent(theme.id)}/delete">` +
      `<button class="btn-danger btn-sm" type="submit" style="margin-left:auto">Delete</button></form>` +
      `</div></article>`;

    return page({
      modules: navModules(deps.db),
      title: 'Themes — Maverick Wall',
      nav: 'themes',
      heading: 'Themes',
      saved: readSaved(c),
      action: { label: 'New theme', href: 'admin/themes/new' },
      intro:
        'Build your own colours for the wall. A theme you make here is selectable on ' +
        'the Displays screen, as the default or for one screen, beside the four built in.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (custom.length === 0
          ? `<p class="hint">No custom themes yet. The four built-in directions (Board, ` +
            `Kitchen Slate, Paper Almanac, Glance) are always available on the Displays ` +
            `screen. Make your own with “New theme”.</p>`
          : `<div class="grid g2">${custom.map(card).join('')}</div>`) +

        `<h2 class="add">Generate from a colour</h2>` +
        `<p class="hint">Pick one colour — the seed — and a whole matching theme is ` +
        `worked out from it: background, panels, text and the shift colours, every ` +
        `pairing kept readable from across a room. It lands in the builder, so you ` +
        `can adjust anything afterwards.</p>` +
        `<form method="post" action="admin/themes/generate">` +
        `<div class="row-fields">` +
        textField({ label: 'Name', name: 'name', required: true, placeholder: 'Sea glass' }) +
        textField({ label: 'Seed colour', name: 'seed', type: 'color', value: '#4C7FD1' }) +
        selectField({
          label: 'Dark or light',
          name: 'mode',
          optionsHtml:
            `<option value="dark" selected>Dark — for a wall on all evening</option>` +
            `<option value="light">Light — paper-bright</option>`,
        }) +
        `</div>` +
        `<button type="submit">Generate theme</button></form>`,
    });
  }

  function builderPage(
    theme: ThemeRow | null,
    values?: Record<string, unknown>,
    error?: string,
    c?: Context,
  ): string {
    const editing = theme !== null;
    // Prefer a rejected submission's own values, then the stored theme, then the
    // default palette — so nothing a household typed is lost to a validation slip.
    const stored = theme?.tokens as Record<string, string> | undefined;
    const defaults = DEFAULT_TOKENS as Record<string, string>;
    const val = (key: string, fallback: string): string => {
      const submitted = values?.[key];
      if (typeof submitted === 'string' && submitted !== '') return submitted;
      return stored?.[key] ?? fallback;
    };
    const nameVal =
      typeof values?.['name'] === 'string' ? (values['name'] as string) : (theme?.name ?? '');
    const currentRadius = val('--radius', DEFAULT_TOKENS['--radius']);

    const colourField = (token: (typeof TOKEN_HELP)[number]): string =>
      `<div class="tf-row">` +
      `<input type="color" name="${escapeHtml(token.key)}" ` +
      `value="${escapeHtml(val(token.key, defaults[token.key] ?? '#000000'))}" ` +
      `aria-label="${escapeHtml(token.label)}">` +
      `<div><b>${escapeHtml(token.label)}</b><small>${escapeHtml(token.help)}</small></div>` +
      `</div>`;

    const fontField = (token: string, label: string, help: string): string =>
      selectField({
        label,
        name: token,
        hint: help,
        optionsHtml:
          `<option value=""${val(token, '') === '' ? ' selected' : ''}>Default</option>` +
          FONTS.map(
            (font) =>
              `<option value="${escapeHtml(font.stack)}"${val(token, '') === font.stack ? ' selected' : ''}>` +
              `${escapeHtml(font.label)}</option>`,
          ).join(''),
      });

    const action = editing ? `admin/themes/${encodeURIComponent(theme.id)}` : 'admin/themes';

    return page({
      modules: navModules(deps.db),
      title: `${editing ? 'Edit theme' : 'New theme'} — Maverick Wall`,
      nav: 'themes',
      heading: editing ? 'Edit theme' : 'New theme',
      saved: c === undefined ? undefined : readSaved(c),
      intro:
        'Pick a colour for each part of the wall. The preview updates as you go; ' +
        'save when it looks right. Corners rounds the cards and badges.',
      body:
        `<p><a class="link" href="admin/themes">← All themes</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="${action}" class="theme-builder">` +
        `<div class="tb-controls">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Kitchen',
          value: nameVal,
          attrs: 'maxlength="60"',
        }) +

        `<label class="tb-group">Colours</label>` +
        TOKEN_HELP.map(colourField).join('') +

        selectField({
          label: 'Corners',
          name: 'radius',
          optionsHtml: RADII.map(
            (r) =>
              `<option value="${escapeHtml(r.value)}"${r.value === currentRadius ? ' selected' : ''}>` +
              `${escapeHtml(r.label)}</option>`,
          ).join(''),
        }) +

        `<label class="tb-group">Fonts</label>` +
        fontField('--disp', 'Headings', 'The big type — the clock, dates, the month.') +
        fontField('--f-sans', 'Body', 'Event titles and the everyday text.') +
        fontField('--f-mono', 'Times & numbers', 'Clock digits, times, and data readings.') +

        `<button type="submit">${editing ? 'Save theme' : 'Create theme'}</button>` +
        `</div>` +

        // Enhanced by assets/theme-editor.js: the shadow-DOM preview and the
        // contrast guidance. Absent scripting, the form still saves.
        `<div class="tb-preview">` +
        `<div class="kick">Preview</div>` +
        `<div id="theme-editor"><div id="theme-preview"></div><div id="theme-contrast"></div></div>` +
        `<noscript><p class="hint">The live preview needs JavaScript. Saving does not — ` +
        `pick your colours and save.</p></noscript>` +
        `</div>` +
        `</form>` +
        `<script type="module" src="assets/theme-editor.js"></script>`,
    });
  }
}
