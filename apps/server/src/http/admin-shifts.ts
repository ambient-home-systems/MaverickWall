import type { Context, Hono } from 'hono';
import { confirmDestroyPage, escapeHtml, errorBlock, page, textField } from './html.js';
import {
  createShiftType,
  deleteShiftType,
  moveShiftType,
  readShiftTypes,
  updateShiftType,
  type ShiftTypeRow,
} from '../api/queries.js';
import { checkbox, colour, optionalText, parse, text, z } from '../validation.js';
import { readSaved, savedRedirect } from './saved.js';
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
  start_time: optionalText(5),
  end_time: optionalText(5),
  is_working: checkbox(),
  match_theme: checkbox(),
});

const addBody = z.object({
  label: text('A name for the shift', 40),
  short_code: text('A short code', 3),
  color: colour(),
  start_time: optionalText(5),
  end_time: optionalText(5),
  is_working: checkbox(),
});

/** An `HH:MM` time, or null. A `<input type=time>` submits this shape or empty. */
function normaliseTime(value: string | undefined): string | null {
  return value !== undefined && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

export function registerShiftTypeRoutes(app: Hono, deps: AdminDeps): void {
  app.get('/admin/shifts/types', (c: Context) => c.html(typesPage(c)));

  app.post('/admin/shifts/types', async (c: Context) => {
    const shaped = parse(addBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(typesPage(c, shaped.message), 400);
    createShiftType(deps.db, {
      label: shaped.value.label,
      shortCode: shaped.value.short_code,
      // A custom type follows the "Other shift" theme slot when it later opts
      // into "match theme"; until then its own colour is what shows.
      colorToken: '--s-straight',
      color: shaped.value.color,
      startTime: normaliseTime(shaped.value.start_time),
      endTime: normaliseTime(shaped.value.end_time),
      isWorking: shaped.value.is_working,
    });
    return savedRedirect(c, '/admin/shifts/types', 'shift-type-added');
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
    return savedRedirect(c, '/admin/shifts/types', 'shift-type-added');
  });

  app.post('/admin/shifts/types/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const existing = readShiftTypes(deps.db).find((t) => t.id === id);
    if (existing === undefined) return c.redirect('/admin/shifts/types', 302);
    const shaped = parse(editBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(typesPage(c, shaped.message), 400);
    updateShiftType(deps.db, id, {
      label: shaped.value.label,
      shortCode: shaped.value.short_code,
      colorToken: existing.colorToken,
      // "Match theme" clears the explicit colour so the theme's slot shows again.
      color: shaped.value.match_theme ? null : shaped.value.color,
      startTime: normaliseTime(shaped.value.start_time),
      endTime: normaliseTime(shaped.value.end_time),
      isWorking: shaped.value.is_working,
    });
    return savedRedirect(c, '/admin/shifts/types', 'shift-type-saved');
  });

  /**
   * Removing a shift type asks first — the same GET-then-POST shape as every
   * other destructive control, in place of the one-click "Remove" the card
   * used to post directly.
   */
  app.get('/admin/shifts/types/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const type = readShiftTypes(deps.db).find((candidate) => candidate.id === id);
    if (type === undefined) return c.redirect('/admin/shifts/types', 302);
    return c.html(
      confirmDestroyPage({
        modules: navModules(deps.db),
        title: 'Remove shift type',
        nav: 'shifts',
        heading: `Remove “${type.label}”?`,
        intro:
          'Any rotation still referring to it keeps working, but you will no ' +
          'longer be able to assign it — so a type in use cannot be removed. ' +
          'This cannot be undone.',
        destroyAction: `admin/shifts/types/${encodeURIComponent(id)}/delete`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/shifts/types',
      }),
    );
  });

  app.post('/admin/shifts/types/:id/delete', (c: Context) => {
    const result = deleteShiftType(deps.db, c.req.param('id') ?? '');
    if (!result.ok) return c.html(typesPage(c, result.message), 400);
    return savedRedirect(c, '/admin/shifts/types', 'shift-type-removed');
  });

  app.post('/admin/shifts/types/:id/move', async (c: Context) => {
    const dir = String(((await c.req.parseBody()) as Record<string, unknown>)['dir'] ?? '');
    moveShiftType(deps.db, c.req.param('id') ?? '', dir === 'up' ? 'up' : 'down');
    return savedRedirect(c, '/admin/shifts/types', 'order-saved');
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
      textField({ label: 'Name', name: 'label', required: true, value: type.label, attrs: 'maxlength="40"' }) +
      textField({ label: 'Short code', name: 'short_code', required: true, value: type.shortCode, attrs: 'maxlength="3"' }) +
      textField({ label: 'Colour', name: 'color', type: 'color', value: swatch }) +
      `</div>` +
      `<div class="row-fields">` +
      textField({ label: 'Starts (optional)', name: 'start_time', type: 'time', value: type.startTime ?? '' }) +
      textField({ label: 'Ends (optional)', name: 'end_time', type: 'time', value: type.endTime ?? '' }) +
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
      `<form method="get" action="admin/shifts/types/${id}/delete">` +
      `<button class="btn-danger" type="submit" style="margin-left:auto">Remove</button></form>` +
      `</div></article>`
    );
  }

  function typesPage(c: Context, error?: string): string {
    const types = readShiftTypes(deps.db);
    return page({
      modules: navModules(deps.db),
      title: 'Shift types — Maverick Wall',
      nav: 'shifts',
      heading: 'Shift types',
      saved: readSaved(c),
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
        textField({ label: 'Name', name: 'label', required: true, placeholder: 'Swing', attrs: 'maxlength="40"' }) +
        textField({ label: 'Short code', name: 'short_code', required: true, placeholder: 'Sw', attrs: 'maxlength="3"' }) +
        textField({ label: 'Colour', name: 'color', type: 'color', value: '#6b7684' }) +
        `</div>` +
        `<div class="row-fields">` +
        textField({ label: 'Starts (optional)', name: 'start_time', type: 'time' }) +
        textField({ label: 'Ends (optional)', name: 'end_time', type: 'time' }) +
        `</div>` +
        `<p class="hint">A window like 07:00–19:00 shows on the wall. Leave blank for ` +
        `a shift with no set time.</p>` +
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
