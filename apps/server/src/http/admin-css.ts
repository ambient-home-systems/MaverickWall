import type { Context, Hono } from 'hono';

import {
  CUSTOM_CSS_MAX_BYTES,
  CUSTOM_CSS_PROMISE,
  refusalSentence,
  sanitiseCustomCss,
  type CssScope,
  type CustomCssOutcome,
} from '../api/custom-css.js';
import {
  readAdminScreens,
  readCustomCss,
  writeCustomCss,
  type CssBlock,
  type ScreenCss,
  type WidgetCssRow,
} from '../api/queries.js';
import { parse, z } from '../validation.js';
import { navModules, type AdminDeps } from './admin.js';
import { emptyState, section, tag } from './components.js';
import { errorBlock, escapeHtml, icon, page, saveRow, textareaField } from './html.js';
import { readSaved, savedRedirect } from './saved.js';
import { selfHref } from './self.js';

/**
 * A wall's Advanced page: its own CSS, and one field per widget (RFC 014 §7).
 *
 * Its own file, on the `admin-walls.ts` precedent, and its own *page* rather
 * than a group inside the wall's settings sheet: that sheet is one form with
 * one Save, and this is a form of its own with a field per widget, a live
 * preview beside it, and a refusal that has to land beside the field it is
 * about. Reached from the Advanced category on the wall's settings, which is
 * where the infrequent things are, and never from the Style tab — RFC 014 §7
 * is explicit that the block is the last option and sits apart from the
 * controls that should be tried first.
 *
 * Three properties, and the first is the one every other form here has had to
 * learn the hard way (the Weather screen, RFC 009 Phase 3.2):
 *
 *  - **A refusal echoes the body back.** Every block the household posted is
 *    put back into its textarea on the 400, with the sanitiser's sentence
 *    beside the field it refused, and the form is handed back already dirty
 *    so Save is live. A page that re-rendered from the stored row would throw
 *    away the edit the household is being asked to fix.
 *  - **Absent is unchanged.** A widget the form did not name keeps its CSS
 *    — the gutter's rule — because a page rendered before a widget was added
 *    must not clear what it never showed; a widget the household emptied is
 *    stored as none. Only widgets on this wall are ever written, whatever ids
 *    a body names.
 *  - **Nothing is parsed at render time.** The page reads the household's own
 *    text off the row and the wall reads the scoped output off the row; the
 *    parser runs here, on save and on the live check, and nowhere the wall's
 *    poll can reach.
 *
 * The live preview is a first-party script (`assets/css-editor.js`) that
 * posts the fields to `/check` as they are typed and inserts what comes back
 * into a preview of this wall through the CSSOM — the same door the wall
 * uses. Absent scripting the form still saves, and the sentence beside each
 * field is still the sanitiser's.
 */

/** What the editor calls each widget type — the display's own palette, transcribed. */
const WIDGET_LABELS: Readonly<Record<string, string>> = {
  clock: 'Clock',
  calendar: 'Calendar',
  weather: 'Weather',
  homeassistant: 'Home Assistant',
  shift: 'Shift',
  countdown: 'Countdown',
  notes: 'Notes',
  todo: 'To-do',
  chores: 'Chores',
  image: 'Image',
  external: 'Module',
  group: 'Group',
};

const WALL_FIELD = 'css_wall';
const WIDGET_FIELD_PREFIX = 'css_w_';

/**
 * The form's fields, by name: the wall's, one per widget, and a marker.
 *
 * A record with a key schema rather than an object, because the widget fields
 * are named after ids the page minted. The value bound is loose on purpose —
 * the sanitiser's own 8 KB sentence is the one a household should read, and a
 * schema that refused first would say "too long" with no number.
 */
const FIELD_NAME = new RegExp(`^(${WALL_FIELD}|css_form|${WIDGET_FIELD_PREFIX}.{1,64})$`);
const cssFormBody = z.record(z.string().regex(FIELD_NAME), z.string().max(CUSTOM_CSS_MAX_BYTES * 8));
const cssCheckBody = z
  .object({ blocks: z.record(z.string().regex(FIELD_NAME), z.string().max(CUSTOM_CSS_MAX_BYTES * 8)) })
  .strict();

/** What the page says about one widget, in the order a household reads it. */
function widgetName(row: WidgetCssRow): { readonly label: string; readonly where: string } {
  const config = typeof row.config === 'object' && row.config !== null ? (row.config as Record<string, unknown>) : {};
  const title = typeof config['title'] === 'string' ? config['title'].trim() : '';
  const label = (WIDGET_LABELS[row.type] ?? row.type) + (title === '' ? '' : ` — “${title}”`);
  const where = row.orientation + (row.slot === null ? '' : `, ${row.slot} layout`);
  return { label, where };
}

/** A refusal per field, or a sentence about the whole form. */
interface Echo {
  readonly values: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly message: string;
}

export function registerCssRoutes(app: Hono, deps: AdminDeps): void {
  /** A paired browser wall by id, or where to send anything else. */
  const wallOr = (
    c: Context,
    id: string,
  ): { readonly wall: { readonly id: string; readonly name: string } } | { readonly redirect: Response } => {
    const screen = readAdminScreens(deps.db).find((s) => s.id === id && s.revokedAt === null);
    if (screen === undefined) return { redirect: c.redirect('/admin/walls', 302) };
    // A panel draws one bit from a widget's config and reads no stylesheet;
    // its page says so where the household would look.
    if (screen.kind === 'epaper') {
      return { redirect: c.redirect(`/admin/epaper/${encodeURIComponent(id)}/design`, 302) };
    }
    return { wall: { id: screen.id, name: screen.name } };
  };

  function cssPage(
    c: Context,
    wall: { readonly id: string; readonly name: string },
    css: ScreenCss,
    echo?: Echo,
  ): string {
    const id = encodeURIComponent(wall.id);
    const value = (name: string, stored: string | null): string =>
      echo !== undefined && name in echo.values ? (echo.values[name] as string) : (stored ?? '');
    const fieldError = (name: string): { readonly error: string } | {} =>
      echo !== undefined && name in echo.errors ? { error: echo.errors[name] as string } : {};
    /** Where the live check writes its sentence for a field; empty until it has one. */
    const live = (name: string): string =>
      `<p class="field-hint is-error css-live" data-css-live="${escapeHtml(name)}" aria-live="polite" hidden></p>`;

    const wallField =
      textareaField({
        label: 'CSS for the whole wall',
        name: WALL_FIELD,
        value: value(WALL_FIELD, css.wall.source),
        rows: 10,
        placeholder: '.fw-calendar .hz-num { font-weight: 300 }',
        attrs: 'spellcheck="false" autocapitalize="off" autocorrect="off" data-css-scope="wall"',
        hint: 'Matched inside the layout, and nowhere outside it. .fw is any widget’s box; .fw-clock, .fw-calendar and so on are one kind of widget’s.',
        ...fieldError(WALL_FIELD),
      }) + live(WALL_FIELD);

    const widgetFields =
      css.widgets.length === 0
        ? emptyState('No widgets on this wall yet', { label: 'Open the layout', href: `admin/walls/${id}#layout` })
        : css.widgets
            .map((row) => {
              const name = `${WIDGET_FIELD_PREFIX}${row.id}`;
              const { label, where } = widgetName(row);
              const has = value(name, row.source).trim() !== '';
              const open = has || (echo !== undefined && name in echo.errors);
              return (
                `<details class="disclose css-widget"${open ? ' open' : ''}>` +
                `<summary>${escapeHtml(label)} <small>${escapeHtml(where)}</small>` +
                (has ? ` ${tag('Has CSS', 'accent')}` : '') +
                `</summary>` +
                textareaField({
                  label: `CSS for this ${WIDGET_LABELS[row.type] ?? row.type}`,
                  name,
                  value: value(name, row.source),
                  rows: 6,
                  placeholder: '.clock { letter-spacing: 0.1em }',
                  attrs: `spellcheck="false" autocapitalize="off" autocorrect="off" data-css-scope="${escapeHtml(row.id)}"`,
                  ...fieldError(name),
                }) +
                live(name) +
                `</details>`
              );
            })
            .join('');

    const body =
      (echo === undefined ? '' : errorBlock(echo.message)) +
      `<form method="post" action="admin/walls/${id}/css" class="css-builder" ` +
      // Handed back dirty on a refusal, so Save is live over the edit being fixed.
      `data-dirty${echo === undefined ? '' : '="dirty"'}>` +
      `<input type="hidden" name="css_form" value="1">` +
      `<div class="tb-controls css-fields">` +
      section(
        'This wall',
        'Rules for the whole layout. What you write here is checked when you save, and anything that could fetch from elsewhere, move, or reach outside the layout is refused and named by line.',
        wallField,
      ) +
      section(
        'Widgets',
        'One field per widget, matched inside that widget’s own box and nowhere else. A widget added later starts with none.',
        widgetFields,
      ) +
      saveRow(`admin/walls/${id}/css`, 'Save CSS') +
      `</div>` +
      // Enhanced by assets/css-editor.js: the live preview and the sentence
      // beside each field as it is typed. Absent scripting, the form still
      // saves and the same sentences come back on the page.
      `<div class="tb-preview">` +
      `<div class="kick">Preview</div>` +
      `<div id="css-editor" data-screen="${escapeHtml(wall.id)}"><div id="css-preview"></div></div>` +
      `<noscript><p class="hint">The live preview needs JavaScript. Saving does not — ` +
      `write your rules and save.</p></noscript>` +
      `</div>` +
      `</form>` +
      `<script type="module" src="assets/css-editor.js"></script>`;

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `Custom CSS — ${wall.name} — Maverick Wall`,
      nav: 'walls',
      heading: 'Custom CSS',
      saved: readSaved(c),
      back: { label: wall.name, href: `admin/walls/${id}` },
      intro:
        `Your own CSS for ${wall.name}, and for each widget on it. ` +
        CUSTOM_CSS_PROMISE +
        ' Colours and type chosen in a widget’s own settings are written on its box directly and win there; rules here reach everything inside it.',
      body,
    });
  }

  app.get('/admin/walls/:id/css', (c: Context) => {
    const found = wallOr(c, c.req.param('id') ?? '');
    if ('redirect' in found) return found.redirect;
    const css = readCustomCss(deps.db, found.wall.id);
    if (css === undefined) return c.redirect('/admin/walls', 302);
    return c.html(cssPage(c, found.wall, css));
  });

  /**
   * One block through the sanitiser, keyed by the field it came from.
   *
   * The widget's scope is its id, read off the field name — and only a widget
   * on this wall is ever scoped, so a stale page naming a widget the household
   * has since removed is ignored rather than written.
   */
  const scopeFor = (name: string, css: ScreenCss): CssScope | undefined => {
    if (name === WALL_FIELD) return { kind: 'wall' };
    if (!name.startsWith(WIDGET_FIELD_PREFIX)) return undefined;
    const id = name.slice(WIDGET_FIELD_PREFIX.length);
    return css.widgets.some((row) => row.id === id) ? { kind: 'widget', id } : undefined;
  };

  app.post('/admin/walls/:id/css', async (c: Context) => {
    const found = wallOr(c, c.req.param('id') ?? '');
    if ('redirect' in found) return found.redirect;
    const css = readCustomCss(deps.db, found.wall.id);
    if (css === undefined) return c.redirect('/admin/walls', 302);

    const shaped = parse(cssFormBody, await c.req.parseBody());
    if (!shaped.ok) {
      return c.html(cssPage(c, found.wall, css, { values: {}, errors: {}, message: shaped.message }), 400);
    }
    if (shaped.value['css_form'] !== '1') {
      // A body that is not this form's — a stale page, or somebody else's —
      // changes nothing rather than clearing every block on the wall.
      return c.html(
        cssPage(c, found.wall, css, {
          values: {},
          errors: {},
          message: 'That page is out of date. Reload it and try again.',
        }),
        400,
      );
    }

    const errors: Record<string, string> = {};
    const values: Record<string, string> = {};
    const widgets = new Map<string, CssBlock>();
    let wall: CssBlock | undefined;
    for (const [name, source] of Object.entries(shaped.value)) {
      const scope = scopeFor(name, css);
      if (scope === undefined) continue;
      values[name] = source;
      const outcome = sanitiseCustomCss(source, scope);
      if (!outcome.ok) {
        errors[name] = refusalSentence(outcome);
        continue;
      }
      const block = { source, scoped: outcome.css };
      if (scope.kind === 'wall') wall = block;
      else widgets.set(scope.id, block);
    }
    const refused = Object.keys(errors).length;
    if (refused > 0) {
      return c.html(
        cssPage(c, found.wall, css, {
          values,
          errors,
          message:
            refused === 1
              ? 'One of these could not be saved. Nothing was changed — the reason is beside the field.'
              : `${refused} of these could not be saved. Nothing was changed — the reasons are beside the fields.`,
        }),
        400,
      );
    }
    writeCustomCss(deps.db, found.wall.id, { ...(wall === undefined ? {} : { wall }), widgets });
    return savedRedirect(c, `/admin/walls/${encodeURIComponent(found.wall.id)}/css`, 'wall-css');
  });

  /**
   * The live check: the same sanitiser, on the fields as they are typed, and
   * nothing written. Answers per field, so the page can put a sentence beside
   * the one that was refused and hand the preview the ones that were not.
   */
  app.post('/admin/walls/:id/css/check', async (c: Context) => {
    const found = wallOr(c, c.req.param('id') ?? '');
    if ('redirect' in found) return c.json({ ok: false, message: 'That wall is no longer there.' }, 404);
    const css = readCustomCss(deps.db, found.wall.id);
    if (css === undefined) return c.json({ ok: false, message: 'That wall is no longer there.' }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'That was not readable as JSON.' }, 400);
    }
    const shaped = parse(cssCheckBody, raw);
    if (!shaped.ok) return c.json({ ok: false, message: shaped.message }, 400);

    const blocks: Record<string, CustomCssOutcome & { readonly sentence?: string }> = {};
    for (const [name, source] of Object.entries(shaped.value.blocks)) {
      const scope = scopeFor(name, css);
      if (scope === undefined) continue;
      const outcome = sanitiseCustomCss(source, scope);
      blocks[name] = outcome.ok ? outcome : { ...outcome, sentence: refusalSentence(outcome) };
    }
    return c.json({ ok: true, blocks });
  });
}

/** The row on the wall's Advanced category that leads here. */
export function cssAdvancedRow(wallId: string): string {
  const id = encodeURIComponent(wallId);
  return (
    `<a class="arow" href="admin/walls/${id}/css">` +
    `<span class="arow-text">Custom CSS` +
    `<small>Your own CSS for this wall and for each widget on it, checked when you save.</small></span>` +
    `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>`
  );
}
