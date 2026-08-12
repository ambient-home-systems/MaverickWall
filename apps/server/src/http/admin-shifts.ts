import type { Context, Hono } from 'hono';
import { escapeHtml, errorBlock, page } from './html.js';
import {
  createShiftType,
  deleteShiftType,
  moveShiftType,
  readShiftTypes,
  updateShiftType,
  type ShiftTypeRow,
} from '../api/queries.js';
import { checkbox, colour, parse, text, z } from '../validation.js';
import { navModules, type AdminDeps } from './admin.js';

/**
 * The Shift Types editor — the flexible half of the Work Schedule.
 *
 * A household names its own shifts (not everyone works Days / Mids / Straights),
 * colours them, marks them working or off, and adds time-off types. The stable
 * `key` a rotation references never changes here; only the label, colour, code
 * and working flag do — which is why renaming is free. Colour is per type: an
 * explicit hue, or "match theme" to follow the theme's shift colour so a custom
 * theme re-colours it.
 */

/** The theme's default shift hues, for a colour picker's starting value only. */
const SLOT_HEX: Readonly<Record<string, string>> = {
  '--s-day': '#e8a33d',
  '--s-night': '#4c7fd1',
  '--s-break': '#35916a',
  '--s-straight': '#6b7684',
};

/** A common time-off / on-call type, offered as a one-click add. */
const PRESETS: Readonly<Record<string, { label: string; shortCode: string; color: string; isWorking: boolean }>> = {
  vacation: { label: 'Vacation', shortCode: 'V', color: '#8a63d2', isWorking: false },
  sick: { label: 'Sick', shortCode: 'Sk', color: '#c0563f', isWorking: false },
  oncall: { label: 'On-call', shortCode: 'OC', color: '#2f9e8f', isWorking: true },
};

const editBody = z.object({
  label: text('A name for the shift', 40),
  short_code: text('A short code', 3),
  color: colour(),
  is_working: checkbox(),
  match_theme: checkbox(),
});

const addBody = z.object({
  label: text('A name for the shift', 40),
  short_code: text('A short code', 3),
  color: colour(),
  is_working: checkbox(),
});

export function registerShiftTypeRoutes(app: Hono, deps: AdminDeps): void {
  app.get('/admin/shifts/types', (c: Context) => c.html(typesPage()));

  app.post('/admin/shifts/types', async (c: Context) => {
    const shaped = parse(addBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(typesPage(shaped.message), 400);
    createShiftType(deps.db, {
      label: shaped.value.label,
      shortCode: shaped.value.short_code,
      // A custom type follows the "Other shift" theme slot when it later opts
      // into "match theme"; until then its own colour is what shows.
      colorToken: '--s-straight',
      color: shaped.value.color,
      startTime: null,
      endTime: null,
      isWorking: shaped.value.is_working,
    });
    return c.redirect('/admin/shifts/types', 302);
  });

  app.post('/admin/shifts/types/preset', async (c: Context) => {
    const which = String(((await c.req.parseBody()) as Record<string, unknown>)['preset'] ?? '');
    const preset = PRESETS[which];
    if (preset !== undefined) {
      createShiftType(deps.db, {
        label: preset.label,
        shortCode: preset.shortCode,
        colorToken: preset.isWorking ? '--s-straight' : '--s-break',
        color: preset.color,
        startTime: null,
        endTime: null,
        isWorking: preset.isWorking,
      });
    }
    return c.redirect('/admin/shifts/types', 302);
  });

  app.post('/admin/shifts/types/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const existing = readShiftTypes(deps.db).find((t) => t.id === id);
    if (existing === undefined) return c.redirect('/admin/shifts/types', 302);
    const shaped = parse(editBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(typesPage(shaped.message), 400);
    updateShiftType(deps.db, id, {
      label: shaped.value.label,
      shortCode: shaped.value.short_code,
      colorToken: existing.colorToken,
      // "Match theme" clears the explicit colour so the theme's slot shows again.
      color: shaped.value.match_theme ? null : shaped.value.color,
      startTime: existing.startTime ?? null,
      endTime: existing.endTime ?? null,
      isWorking: shaped.value.is_working,
    });
    return c.redirect('/admin/shifts/types', 302);
  });

  app.post('/admin/shifts/types/:id/delete', (c: Context) => {
    const result = deleteShiftType(deps.db, c.req.param('id') ?? '');
    if (!result.ok) return c.html(typesPage(result.message), 400);
    return c.redirect('/admin/shifts/types', 302);
  });

  app.post('/admin/shifts/types/:id/move', async (c: Context) => {
    const dir = String(((await c.req.parseBody()) as Record<string, unknown>)['dir'] ?? '');
    moveShiftType(deps.db, c.req.param('id') ?? '', dir === 'up' ? 'up' : 'down');
    return c.redirect('/admin/shifts/types', 302);
  });

  function typeCard(type: ShiftTypeRow, first: boolean, last: boolean): string {
    const id = encodeURIComponent(type.id);
    const swatch = type.color ?? SLOT_HEX[type.colorToken] ?? '#6b7684';
    const matching = type.color === undefined;
    return (
      `<article class="card">` +
      `<h2><span class="swatch" style="--swatch:${escapeHtml(swatch)}"></span>` +
      `${escapeHtml(type.label)}${type.isWorking ? '' : ' · off'}</h2>` +
      `<form method="post" action="admin/shifts/types/${id}">` +
      `<div class="row-fields">` +
      `<span><label for="l-${type.id}">Name</label>` +
      `<input id="l-${type.id}" name="label" type="text" required maxlength="40" value="${escapeHtml(type.label)}"></span>` +
      `<span><label for="sc-${type.id}">Short code</label>` +
      `<input id="sc-${type.id}" name="short_code" type="text" required maxlength="3" value="${escapeHtml(type.shortCode)}"></span>` +
      `<span><label for="c-${type.id}">Colour</label>` +
      `<input id="c-${type.id}" name="color" type="color" value="${escapeHtml(swatch)}"></span>` +
      `</div>` +
      `<div class="checks">` +
      `<label><input type="checkbox" name="is_working" value="1"${type.isWorking ? ' checked' : ''}> This is a working shift</label>` +
      `<label><input type="checkbox" name="match_theme" value="1"${matching ? ' checked' : ''}> Match the theme’s shift colour instead</label>` +
      `</div>` +
      `<p class="hint">The short code is what the compact month cells show. “Match ` +
      `the theme” follows the theme’s shift colour, so a custom theme re-colours ` +
      `it; otherwise the colour above is used.</p>` +
      `<button type="submit">Save</button></form>` +
      `<div class="row">` +
      (first
        ? ''
        : `<form method="post" action="admin/shifts/types/${id}/move"><input type="hidden" name="dir" value="up">` +
          `<button class="secondary" type="submit">↑ Up</button></form>`) +
      (last
        ? ''
        : `<form method="post" action="admin/shifts/types/${id}/move"><input type="hidden" name="dir" value="down">` +
          `<button class="secondary" type="submit">↓ Down</button></form>`) +
      `<form method="post" action="admin/shifts/types/${id}/delete">` +
      `<button class="btn-danger" type="submit" style="margin-left:auto">Remove</button></form>` +
      `</div></article>`
    );
  }

  function typesPage(error?: string): string {
    const types = readShiftTypes(deps.db);
    return page({
      modules: navModules(deps.db),
      title: 'Shift types — Maverick Wall',
      nav: 'shifts',
      heading: 'Shift types',
      intro:
        'The kinds of shift the wall knows about — their names, short codes and ' +
        'colours. Rename or recolour any of them, add your own, or add a time-off ' +
        'type. A rotation refers to these, so a type in use cannot be removed.',
      body:
        `<p><a class="link" href="admin/shifts">← Work Schedule</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +
        types.map((type, i) => typeCard(type, i === 0, i === types.length - 1)).join('') +

        `<h2 class="add" id="add">Add a shift type</h2>` +
        `<form method="post" action="admin/shifts/types">` +
        `<div class="row-fields">` +
        `<span><label for="new-label">Name</label>` +
        `<input id="new-label" name="label" type="text" required maxlength="40" placeholder="Swing"></span>` +
        `<span><label for="new-code">Short code</label>` +
        `<input id="new-code" name="short_code" type="text" required maxlength="3" placeholder="Sw"></span>` +
        `<span><label for="new-color">Colour</label>` +
        `<input id="new-color" name="color" type="color" value="#6b7684"></span>` +
        `</div>` +
        `<div class="checks"><label><input type="checkbox" name="is_working" value="1" checked> ` +
        `This is a working shift</label></div>` +
        `<button type="submit">Add</button></form>` +

        `<h2 class="add">Add a common type</h2>` +
        `<p class="hint">One-click time-off and on-call types you can then use in a rotation.</p>` +
        `<div class="row">` +
        Object.entries(PRESETS)
          .map(
            ([key, p]) =>
              `<form method="post" action="admin/shifts/types/preset">` +
              `<input type="hidden" name="preset" value="${key}">` +
              `<button class="secondary" type="submit">Add ${escapeHtml(p.label)}</button></form>`,
          )
          .join('') +
        `</div>`,
    });
  }
}
