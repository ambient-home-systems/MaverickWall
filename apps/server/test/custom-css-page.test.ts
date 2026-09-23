import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUSEHOLD_CALENDARS, install, type Installation } from './browser-harness.js';
import { CUSTOM_CSS_PROMISE } from '../src/api/custom-css.js';
import { PANEL_IGNORES } from '../src/epaper/honours.js';
import { SAVED_MESSAGES } from '../src/http/saved.js';

/**
 * A wall's Custom CSS page, through the real app (RFC 014 §7).
 *
 * The sanitiser is enumerated in `custom-css.test.ts`; this is the *page*:
 * that it shows the promise word for word, that a save writes both columns and
 * reaches the manifest scoped, that a refusal is a 400 with the household's own
 * text back in the textarea and the sentence beside it — nothing written — and
 * that the layout editor's rewrite of a canvas keeps a widget's CSS by id,
 * which is the fault that would otherwise arrive the first time somebody
 * dragged a styled box.
 */

process.env['TZ'] = 'UTC';
const SLOW = 120_000;

let wall: Installation;
let screenId: string;
let clockId: string;
let calendarId: string;

function stored(): { source: string | null; scoped: string | null } {
  return wall.db
    .prepare('SELECT custom_css AS source, custom_css_scoped AS scoped FROM screens WHERE id = ?')
    .get(screenId) as { source: string | null; scoped: string | null };
}
function storedWidget(id: string): { source: string | null; scoped: string | null } | undefined {
  return wall.db
    .prepare('SELECT custom_css AS source, custom_css_scoped AS scoped FROM layout_widgets WHERE id = ?')
    .get(id) as { source: string | null; scoped: string | null } | undefined;
}
function post(fields: Record<string, string>): Promise<Response> {
  return wall.post(`/admin/walls/${screenId}/css`, { css_form: '1', ...fields });
}

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1) });
  screenId = await wall.pairWall('Kitchen');
  const row = (type: string): string =>
    (
      wall.db
        .prepare(`SELECT id FROM layout_widgets WHERE screen_id = ? AND orientation = 'portrait' AND type = ? ORDER BY z LIMIT 1`)
        .get(screenId, type) as { id: string }
    ).id;
  clockId = row('clock');
  calendarId = row('calendar');
}, SLOW);

afterAll(async () => {
  await wall.dispose();
});

describe('the page', () => {
  it('is reached from the wall’s Advanced category, and states the promise word for word', async () => {
    const settings = await (await wall.call(`/admin/walls/${screenId}`)).text();
    expect(settings).toContain(`admin/walls/${encodeURIComponent(screenId)}/css`);
    const html = await (await wall.call(`/admin/walls/${screenId}/css`)).text();
    expect(html).toContain(CUSTOM_CSS_PROMISE.replace(/'/g, '&#39;'));
    expect(html).toContain('name="css_wall"');
    expect(html).toContain(`name="css_w_${clockId}"`);
    expect(html).toContain(`name="css_w_${calendarId}"`);
    // Nothing yet, so no textarea carries anything and the disclosures are shut.
    expect(html).not.toContain('Has CSS');
  });

  it('sends a panel to its own page, and a stranger to the list', async () => {
    const made = await wall.post('/admin/epaper', { name: 'Hall tag', preset: 'seeed-7in5', rotation: '0' });
    expect(made.status).toBe(303);
    const panelId = /\/admin\/epaper\/([^/]+)/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
    const panel = await wall.call(`/admin/walls/${panelId}/css`);
    expect(panel.status).toBe(302);
    expect(panel.headers.get('location')).toBe(`/admin/epaper/${panelId}/design`);
    const stranger = await wall.call('/admin/walls/nobody/css');
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get('location')).toBe('/admin/walls');
  });
});

describe('saving', () => {
  it('writes the household’s text and the scoped output, for the wall and for a widget', async () => {
    const saved = await post({
      css_wall: '/* quieter numerals */\n.fw-calendar .hz-num { font-weight: 300 }',
      [`css_w_${clockId}`]: '.clock { letter-spacing: 0.1em }',
    });
    expect(saved.status).toBe(302);
    const landing = saved.headers.get('location') ?? '';
    expect(landing).toContain('saved=wall-css');
    // The strip on the page the save lands on, and its sentence is a claim
    // about a branch that has already happened: both blocks are written.
    expect(await (await wall.call(landing)).text()).toContain(SAVED_MESSAGES['wall-css'].slice(0, 9));
    expect(stored()).toEqual({
      source: '/* quieter numerals */\n.fw-calendar .hz-num { font-weight: 300 }',
      scoped: '.canvas .fw-calendar .hz-num,.canvas.fw-calendar .hz-num{font-weight:300}',
    });
    expect(storedWidget(clockId)).toEqual({
      source: '.clock { letter-spacing: 0.1em }',
      scoped: `[data-widget-id="${clockId}"] .clock,[data-widget-id="${clockId}"].clock{letter-spacing:0.1em}`,
    });
    expect(storedWidget(calendarId)).toEqual({ source: null, scoped: null });
  });

  it('reaches the manifest as the scoped text only, on the wall and on the widget', async () => {
    const response = await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`);
    const manifest = (await response.json()) as {
      screen: { customCss?: string };
      layout: { portrait: { widgets: { id: string; customCss?: string }[] } };
    };
    expect(manifest.screen.customCss).toBe('.canvas .fw-calendar .hz-num,.canvas.fw-calendar .hz-num{font-weight:300}');
    const clock = manifest.layout.portrait.widgets.find((w) => w.id === clockId);
    expect(clock?.customCss).toContain(`[data-widget-id="${clockId}"] .clock`);
    const text = JSON.stringify(manifest);
    expect(text).not.toContain('quieter numerals');
    expect(text).not.toContain('letter-spacing: 0.1em');
  });

  it('shows the saved text back, comments and all, and marks the widget that has one', async () => {
    const html = await (await wall.call(`/admin/walls/${screenId}/css`)).text();
    expect(html).toContain('/* quieter numerals */');
    expect(html).toContain('.clock { letter-spacing: 0.1em }');
    expect(html).toContain('Has CSS');
    // And no strip on a plain visit: a token is a claim about a save.
    expect(html).not.toContain(SAVED_MESSAGES['wall-css'].slice(0, 9));
  });

  it('leaves a widget the form did not name exactly as it found it', async () => {
    const saved = await post({ css_wall: '.fw { padding: 0 }' });
    expect(saved.status).toBe(302);
    expect(storedWidget(clockId)?.source).toBe('.clock { letter-spacing: 0.1em }');
    expect(stored().scoped).toBe('.canvas .fw,.canvas.fw{padding:0}');
  });

  it('stores an emptied field as none, on both columns', async () => {
    const saved = await post({ [`css_w_${clockId}`]: '   ' });
    expect(saved.status).toBe(302);
    expect(storedWidget(clockId)).toEqual({ source: null, scoped: null });
  });

  it('ignores a widget that is not on this wall, rather than writing it', async () => {
    const saved = await post({ css_w_stranger: '.x { color: red }' });
    expect(saved.status).toBe(302);
    expect(wall.db.prepare("SELECT COUNT(*) AS n FROM layout_widgets WHERE custom_css IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it('refuses a body that is not this form’s, and changes nothing', async () => {
    const before = stored();
    const stale = await wall.post(`/admin/walls/${screenId}/css`, { css_wall: '.fw { color: red }' });
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('out of date');
    expect(stored()).toEqual(before);
  });
});

describe('a refusal', () => {
  it('is a 400 that echoes the text into the textarea with the sentence beside it, and writes nothing', async () => {
    const before = stored();
    const refused = await post({
      css_wall: '.fw { color: red }\n.fw { position: fixed }',
      [`css_w_${clockId}`]: '.clock { color: #fff }',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    // The household's own text, back where they typed it.
    expect(html).toContain('.fw { color: red }\n.fw { position: fixed }');
    expect(html).toContain('.clock { color: #fff }');
    // The sentence, beside the field it is about, naming the line.
    expect(html).toContain('Line 2: position: fixed is not allowed here');
    expect(html).toContain('One of these could not be saved. Nothing was changed');
    // Handed back already dirty, so Save is live over the edit being fixed.
    expect(html).toMatch(/<form[^>]*data-dirty="dirty"/);
    expect(stored()).toEqual(before);
    // The widget that was fine is not written either: nothing was changed.
    expect(storedWidget(clockId)).toEqual({ source: null, scoped: null });
  });

  it('counts two refusals as two', async () => {
    const refused = await post({
      css_wall: '@import "x";',
      [`css_w_${clockId}`]: 'body { display: none }',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('2 of these could not be saved');
    expect(html).toContain('@import is not allowed here');
    expect(html).toContain('reaches outside the widget');
  });
});

describe('the live check', () => {
  it('answers per field with the same sanitiser, and writes nothing', async () => {
    const before = stored();
    const response = await wall.call(`/admin/walls/${screenId}/css/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        blocks: {
          css_wall: '.fw { color: red }',
          [`css_w_${clockId}`]: '.clock { position: sticky }',
          css_w_stranger: '.x { color: red }',
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      blocks: Record<string, { ok: boolean; css?: string; sentence?: string; line?: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.blocks['css_wall']).toEqual({ ok: true, css: '.canvas .fw,.canvas.fw{color:red}', rules: 1 });
    expect(body.blocks[`css_w_${clockId}`]?.ok).toBe(false);
    expect(body.blocks[`css_w_${clockId}`]?.sentence).toMatch(/^Line 1: position: sticky/);
    expect(body.blocks['css_w_stranger']).toBeUndefined();
    expect(stored()).toEqual(before);
  });

  it('refuses a body that is not JSON, or not the shape', async () => {
    const notJson = await wall.call(`/admin/walls/${screenId}/css/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'nope',
    });
    expect(notJson.status).toBe(400);
    const wrongShape = await wall.call(`/admin/walls/${screenId}/css/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: { css_wall: 12 } }),
    });
    expect(wrongShape.status).toBe(400);
  });
});

describe('the layout editor’s rewrite of a canvas', () => {
  it('keeps a widget’s CSS by id, drops it with the widget, and starts a new id with none', async () => {
    const saved = await post({ [`css_w_${clockId}`]: '.clock { color: #fff }', [`css_w_${calendarId}`]: '.hz-num { color: #000 }' });
    expect(saved.status).toBe(302);
    const rows = wall.db
      .prepare(`SELECT id, type, x, y, w, h, z, config FROM layout_widgets WHERE screen_id = ? AND orientation = 'portrait' AND slot IS NULL AND parent_id IS NULL`)
      .all(screenId) as { id: string; type: string; x: number; y: number; w: number; h: number; z: number; config: string | null }[];
    // The clock moved, the calendar was removed, and a fresh note was added.
    const widgets = rows
      .filter((row) => row.id !== calendarId)
      .map((row) => ({
        id: row.id, type: row.type, x: row.id === clockId ? 0.5 : row.x, y: row.y, w: row.w, h: row.h, z: row.z,
        ...(row.config === null ? {} : { config: JSON.parse(row.config) as unknown }),
      }));
    widgets.push({ id: 'w-fresh-note', type: 'notes', x: 0, y: 0.9, w: 0.5, h: 0.1, z: 9, config: { text: 'hello' } });
    const rewritten = await wall.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen: screenId, mode: 'freeform', aspect: 0.5625, widgets }),
    });
    expect(rewritten.status, await rewritten.text()).toBe(200);
    expect(storedWidget(clockId)?.source).toBe('.clock { color: #fff }');
    expect(storedWidget(clockId)?.scoped).toContain(`[data-widget-id="${clockId}"]`);
    expect(storedWidget(calendarId)).toBeUndefined();
    expect(storedWidget('w-fresh-note')).toEqual({ source: null, scoped: null });
  });
});

describe('the panel', () => {
  it('states the same promise beside the key it ignores, word for word', () => {
    const entry = PANEL_IGNORES.find((row) => row.key === 'customCss');
    expect(entry?.why).toBe(CUSTOM_CSS_PROMISE);
    expect(entry?.label).toBe('Custom CSS');
  });
});
