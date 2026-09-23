import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildManifest, manifestEtag, type BuildManifestInput } from '../src/api/manifest.js';
import { renderScreenFrame, type FrameScreen } from '../src/epaper/frame.js';
import {
  MAX_LAYOUT_SLOTS,
  SLOT_NAME,
  scheduledSlot,
  windowContains,
} from '../src/api/layout-slots.js';
import {
  clearLayout,
  deleteScreen,
  readLayoutSchedule,
  readLayoutSlots,
  readLayoutWidgets,
} from '../src/api/queries.js';
import { HOUSEHOLD_CALENDARS, install, type Installation } from './browser-harness.js';

/**
 * Scheduled canvases (RFC 014 §5.2), on the server side of the manifest.
 *
 * Three things are load-bearing and each is a block below. **A wall with one
 * canvas and no schedule sends the document it always sent** — not "the new
 * keys are undefined" but *absent*, compared as text, because `manifestEtag`
 * hashes the serialisation and a `"slots": []` on every wall in the world
 * would churn every stored ETag at one image pull. **The ETag moves when a
 * schedule does**, which is free — the layout is in the preimage — and pinned
 * anyway, because without it a schedule saved at noon would reach the wall
 * only when its calendar happened to change. And **the boundary refuses what
 * the wall could not draw**: a fifth slot, a slot on a panel, half a window.
 *
 * `browser-scheduled-canvas.test.ts` is the other half: the wall crossing the
 * boundary on its own tick, with the server blocked.
 */

process.env['TZ'] = 'UTC';
const SLOW = 120_000;

const HOUSEHOLD = {
  timezone: 'Europe/London',
  shiftEnabled: 0,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  clock24: 1,
  weekStart: 'sunday',
  layoutMode: 'freeform',
  layoutAspect: 0.5625,
  layoutLandscapeAspect: 1.7778,
  layoutBackground: null,
  layoutLandscapeBackground: null,
} as unknown as BuildManifestInput['household'];

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

const CLOCK = { id: 'w-clock', type: 'clock', x: 0, y: 0, w: 1, h: 0.2, z: 0, config: undefined };
const NOTE = {
  id: 'w-note', type: 'notes', x: 0, y: 0.2, w: 1, h: 0.3, z: 1,
  config: { text: 'Bags by the door' },
};

const BASE: BuildManifestInput = {
  household: HOUSEHOLD,
  events: [],
  sources: [],
  people: [],
  shiftTypes: [],
  shiftPlans: [],
  shiftOverrides: [],
  today: '2026-09-10',
  daysBefore: 1,
  daysAfter: 5,
  now: NOW,
  appVersion: '0.1.0-test',
  layoutWidgetsPortrait: [CLOCK],
  layoutWidgetsLandscape: [CLOCK],
  screen: { orientation: 'auto', rotation: 0, allowDismiss: false, allowChores: false, theme: 'panels' },
};

const PANEL: FrameScreen = { panelWidth: 800, panelHeight: 480, panelColour: 'bw', rotation: 0 };

describe('a wall with one canvas and no schedule', () => {
  it('sends the document it sent before slots existed, byte for byte', () => {
    const before = buildManifest(BASE);
    const after = buildManifest({ ...BASE, layoutSlots: [], layoutSchedule: [] });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(manifestEtag(after)).toBe(manifestEtag(before));
    // The keys the layout carried before this feature, and no others: the
    // slots and the schedule are spread away, never emitted empty.
    expect(Object.keys(after.layout)).toEqual(['mode', 'portrait', 'landscape']);
  });

  it('sends it too when the only named slot has nothing drawable, and when every schedule row is unreadable', () => {
    const before = buildManifest(BASE);
    const empty = buildManifest({
      ...BASE,
      // A slot whose every widget is a type the wall has no renderer for is a
      // slot with nothing to say; the wall would fall back to the default
      // for it anyway, so it is not carried.
      layoutSlots: [{ slot: 'morning', portrait: [{ ...CLOCK, type: 'website' }], landscape: [] }],
      layoutSchedule: [
        { slot: 'Morning', from: '06:30', to: '08:30' },
        { slot: 'morning', from: '6:30', to: '08:30' },
        { slot: 'morning', from: '07:00', to: '07:00' },
      ],
    });
    expect(JSON.stringify(empty)).toBe(JSON.stringify(before));
  });
});

describe('a wall with a scheduled canvas', () => {
  const scheduled = buildManifest({
    ...BASE,
    layoutSlots: [{ slot: 'morning', portrait: [CLOCK, NOTE], landscape: [] }],
    layoutSchedule: [{ slot: 'morning', from: '06:30', to: '08:30' }],
  });

  it('carries every slot’s widgets and the schedule, and the ETag moves', () => {
    expect(scheduled.layout.schedule).toEqual([{ slot: 'morning', from: '06:30', to: '08:30' }]);
    expect(scheduled.layout.slots?.map((slot) => slot.slot)).toEqual(['morning']);
    expect(scheduled.layout.slots?.[0]?.portrait.widgets.map((w) => w.id)).toEqual(['w-clock', 'w-note']);
    // A slot arranged in portrait only carries an empty landscape, which the
    // wall reads as "draw the default landscape" rather than as a blank.
    expect(scheduled.layout.slots?.[0]?.landscape.widgets).toEqual([]);
    // The default canvas is untouched by the slot beside it.
    expect(scheduled.layout.portrait.widgets.map((w) => w.id)).toEqual(['w-clock']);
    expect(manifestEtag(scheduled)).not.toBe(manifestEtag(buildManifest(BASE)));
    // A schedule alone moves it too — that is what reaches a wall at noon.
    const rescheduled = buildManifest({
      ...BASE,
      layoutSlots: [{ slot: 'morning', portrait: [CLOCK, NOTE], landscape: [] }],
      layoutSchedule: [{ slot: 'morning', from: '06:31', to: '08:30' }],
    });
    expect(manifestEtag(rescheduled)).not.toBe(manifestEtag(scheduled));
  });

  it('draws the same panel frame as an unscheduled wall, to the pixel and to the ETag', () => {
    /*
     * A panel follows a wall's *default* slot only: a battery panel that
     * sleeps most of an hour cannot honour a schedule, so the renderer reads
     * `layout.portrait`/`layout.landscape` and never a slot. The frame ETag is
     * derived from the manifest, so the schedule reaching it would move that
     * — asserted both ways.
     */
    const plain = renderScreenFrame(buildManifest(BASE), PANEL);
    const withSchedule = renderScreenFrame(scheduled, PANEL);
    expect(Buffer.from(withSchedule.fb.bits)).toEqual(Buffer.from(plain.fb.bits));
  });
});

describe('the window arithmetic', () => {
  it('is the display’s, character for character', () => {
    /*
     * The display bundle cannot import the server and the server cannot
     * import the bundle, so `windowContains` is written twice and held to one
     * body here — the seam `epaper-ladder-parity` and `tier-parity` sit at.
     * The slot-name rule is transcribed into the editor too.
     */
    const body = (source: string): string => {
      const start = source.indexOf('export function windowContains(');
      const end = source.indexOf('\n}\n', start);
      return source.slice(source.indexOf('{', start), end + 2);
    };
    const server = readFileSync(new URL('../src/api/layout-slots.ts', import.meta.url), 'utf8');
    const display = readFileSync(new URL('../../display/src/canvas-schedule.ts', import.meta.url), 'utf8');
    expect(body(server)).toBe(body(display));
    const editor = readFileSync(new URL('../../display/src/layout-editor.ts', import.meta.url), 'utf8');
    expect(editor).toContain(`const SLOT_NAME = ${SLOT_NAME.toString()};`);
  });

  it('picks the first window containing now, wrapping past midnight', () => {
    expect(windowContains('21:00', '06:00', '00:30')).toBe(true);
    expect(scheduledSlot([{ slot: 'night', from: '21:00', to: '06:00' }], '12:00')).toBeUndefined();
    expect(scheduledSlot([{ slot: 'night', from: '21:00', to: '06:00' }], '05:59')).toBe('night');
  });
});

describe('through the real app', () => {
  let wall: Installation;
  let screenId: string;

  beforeAll(async () => {
    wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1) });
    screenId = await wall.pairWall('Kitchen');
  }, SLOW);

  afterAll(async () => {
    await wall.dispose();
  });

  // Ids minted per slot, as the editor mints them: a widget id is a primary
  // key across every canvas a wall holds, so two slots cannot share one.
  const postCanvas = (slot: string | undefined, widgets: readonly unknown[] = [CLOCK], orientation = 'portrait') =>
    wall.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: screenId,
        orientation,
        mode: 'freeform',
        aspect: 0.5625,
        widgets: widgets.map((w) => {
          const { config: _dropped, ...rest } = w as typeof CLOCK;
          return { ...rest, id: `${rest.id}-${slot ?? 'default'}` };
        }),
        background: null,
        ...(slot === undefined ? {} : { slot }),
      }),
    });

  const settings = (extra: Record<string, string>) =>
    wall.post(`/admin/screens/${screenId}`, {
      name: 'Kitchen',
      orientation: 'auto',
      rotation: '0',
      theme: 'panels',
      clock_24: '',
      ...extra,
    });

  const manifest = async (): Promise<{ layout: { slots?: unknown; schedule?: unknown; portrait: { widgets: { id: string }[] } } }> =>
    (await (await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`)).json()) as never;

  it('saves a named canvas beside the default, and the manifest carries it', async () => {
    const before = await manifest();
    expect(before.layout.slots).toBeUndefined();
    expect((await postCanvas('morning')).status).toBe(200);
    expect(readLayoutSlots(wall.db, screenId)).toEqual(['morning']);
    // The default canvas is exactly what it was: Classic's seed, untouched.
    const after = await manifest();
    expect(after.layout.portrait.widgets.map((w) => w.id)).toEqual(before.layout.portrait.widgets.map((w) => w.id));
    expect((after.layout.slots as { slot: string }[]).map((s) => s.slot)).toEqual(['morning']);
    // No schedule yet, so none travels.
    expect(after.layout.schedule).toBeUndefined();
  });

  it('refuses a slot that is not a name, and a fifth slot with the number', async () => {
    expect((await postCanvas('Morning')).status).toBe(400);
    expect((await postCanvas('a b')).status).toBe(400);
    for (const slot of ['evening', 'weekend', 'spare']) expect((await postCanvas(slot)).status).toBe(200);
    expect(readLayoutSlots(wall.db, screenId)).toHaveLength(MAX_LAYOUT_SLOTS);
    const fifth = await postCanvas('fifth');
    expect(fifth.status).toBe(400);
    expect(((await fifth.json()) as { message: string }).message).toContain(String(MAX_LAYOUT_SLOTS));
    // A save to a slot that already exists is a save, not a new slot.
    expect((await postCanvas('spare', [CLOCK, NOTE])).status).toBe(200);
    expect(readLayoutWidgets(wall.db, screenId, 'portrait', 'spare')).toHaveLength(2);
  });

  it('refuses a slot at a panel', async () => {
    const created = await wall.post('/admin/epaper', {
      name: 'Hall panel', preset: 'seeed-7in5', rotation: '0',
    });
    expect([200, 302, 303]).toContain(created.status);
    const panel = wall.db
      .prepare(`SELECT id FROM screens WHERE kind = 'epaper' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    expect(panel).toBeDefined();
    const refused = await wall.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: panel?.id, orientation: 'landscape', mode: 'freeform', aspect: 1.6667,
        widgets: [{ id: 'p1', type: 'clock', x: 0, y: 0, w: 1, h: 1, z: 0 }], background: null, slot: 'morning',
      }),
    });
    expect(refused.status).toBe(400);
    expect(readLayoutSlots(wall.db, panel?.id ?? '')).toEqual([]);
  });

  it('refuses half a window, a window of no length, and a slot the wall does not hold', async () => {
    const half = await settings({ schedule_form: '1', schedule_slot_1: 'morning', schedule_from_1: '06:30' });
    expect(half.status).toBe(400);
    expect(await half.text()).toContain('give both times');
    const zero = await settings({ schedule_form: '1', schedule_slot_1: 'morning', schedule_from_1: '07:00', schedule_to_1: '07:00' });
    expect(zero.status).toBe(400);
    expect(await zero.text()).toContain('not a window');
    const stale = await settings({ schedule_form: '1', schedule_slot_1: 'gone', schedule_from_1: '06:30', schedule_to_1: '08:30' });
    expect(stale.status).toBe(400);
    const timesOnly = await settings({ schedule_form: '1', schedule_from_1: '06:30', schedule_to_1: '08:30' });
    expect(timesOnly.status).toBe(400);
    expect(await timesOnly.text()).toContain('choose which layout');
    expect(readLayoutSchedule(wall.db, screenId)).toEqual([]);
  });

  it('stores the schedule whole, in the household’s order, and the manifest carries it', async () => {
    const saved = await settings({
      schedule_form: '1',
      // Row 1 empty on purpose: a blank row is no rule, and rows keep their
      // written order below it.
      schedule_slot_2: 'evening', schedule_from_2: '20:00', schedule_to_2: '23:00',
      schedule_slot_3: 'morning', schedule_from_3: '06:30', schedule_to_3: '08:30',
    });
    expect(saved.status).toBe(302);
    expect(readLayoutSchedule(wall.db, screenId)).toEqual([
      { slot: 'evening', from: '20:00', to: '23:00' },
      { slot: 'morning', from: '06:30', to: '08:30' },
    ]);
    expect((await manifest()).layout.schedule).toEqual([
      { slot: 'evening', from: '20:00', to: '23:00' },
      { slot: 'morning', from: '06:30', to: '08:30' },
    ]);
    // The settings page draws the rules back, offering every slot on each.
    const html = await (await wall.call(`/admin/walls/${screenId}`)).text();
    expect(html).toContain('20:00–23:00: evening');
    expect(html).toContain('name="schedule_slot_4"');
  });

  it('leaves the schedule alone for a page that never drew the rows', async () => {
    // The `style_form` rule: a tab rendered before the rows existed posts
    // no marker, and a stale tab saving a timezone must not clear a schedule.
    expect((await settings({})).status).toBe(302);
    expect(readLayoutSchedule(wall.db, screenId)).toHaveLength(2);
  });

  it('removes a slot with every rule naming it, and never the default', async () => {
    const removed = await wall.call('/admin/layout/remove-slot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen: screenId, slot: 'evening' }),
    });
    expect(removed.status).toBe(200);
    expect(readLayoutSlots(wall.db, screenId)).toEqual(['morning', 'spare', 'weekend']);
    expect(readLayoutSchedule(wall.db, screenId)).toEqual([{ slot: 'morning', from: '06:30', to: '08:30' }]);
    expect(readLayoutWidgets(wall.db, screenId, 'portrait').length).toBeGreaterThan(0);
    // The default has no name, so the shape refuses rather than a clause.
    const shapeless = await wall.call('/admin/layout/remove-slot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen: screenId, slot: '' }),
    });
    expect(shapeless.status).toBe(400);
  });

  it('goes with the canvas on a clear and with the row on a forget', async () => {
    const other = await wall.pairWall('Landing');
    const post = (slot: string) =>
      wall.call('/admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: other, orientation: 'portrait', mode: 'freeform', aspect: 0.5625,
          widgets: [{ id: `l-${slot}`, type: 'clock', x: 0, y: 0, w: 1, h: 0.2, z: 0 }], background: null, slot,
        }),
      });
    expect((await post('morning')).status).toBe(200);
    expect(
      (await wall.post(`/admin/screens/${other}`, {
        name: 'Landing', orientation: 'auto', rotation: '0', theme: 'panels', clock_24: '',
        schedule_form: '1', schedule_slot_1: 'morning', schedule_from_1: '06:30', schedule_to_1: '08:30',
      })).status,
    ).toBe(302);
    expect(readLayoutSchedule(wall.db, other)).toHaveLength(1);
    clearLayout(wall.db, other);
    expect(readLayoutSchedule(wall.db, other)).toEqual([]);
    expect(readLayoutSlots(wall.db, other)).toEqual([]);

    expect((await post('morning')).status).toBe(200);
    expect(
      (await wall.post(`/admin/screens/${other}`, {
        name: 'Landing', orientation: 'auto', rotation: '0', theme: 'panels', clock_24: '',
        schedule_form: '1', schedule_slot_1: 'morning', schedule_from_1: '06:30', schedule_to_1: '08:30',
      })).status,
    ).toBe(302);
    wall.db.prepare('UPDATE screens SET revoked_at = ? WHERE id = ?').run(Date.now(), other);
    expect(deleteScreen(wall.db, other)).toBe(true);
    expect(
      (wall.db.prepare('SELECT COUNT(*) AS n FROM layout_schedule WHERE screen_id = ?').get(other) as { n: number }).n,
    ).toBe(0);
  });
});
