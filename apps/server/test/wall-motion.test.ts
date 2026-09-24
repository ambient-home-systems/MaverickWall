import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUSEHOLD_CALENDARS, install, type Installation } from './browser-harness.js';
import { wallMotion } from '../src/wall-motion.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

/**
 * A wall's Motion switch (plan P4.3, decision D7), from the column to the
 * document a wall reads.
 *
 * Three properties, and the second is the one a switch makes hard:
 *
 *  - **Null is on (Q6), except on an e-ink size, where it is off.** One reader,
 *    `wallMotion`, decides it for the manifest and for the switch the settings
 *    page draws, so the page shows what the wall does.
 *  - **The column is written only when the switch was moved.** A switch always
 *    posts an answer, so a handler that stored whatever arrived would lock
 *    motion *on* for a wall saved with a new e-ink size and the switch
 *    untouched — the switch was drawn on while the size was a television. The
 *    form says what it drew (`motion_shown`) and the handler compares.
 *  - **The manifest says only "still".** Absent is on, so a wall nobody touched
 *    sends the document it sent before the column existed, and no stored ETag
 *    churns at one image pull.
 */

process.env['TZ'] = 'UTC';
const SLOW = 120_000;

let wall: Installation;
let screenId: string;

/** The settings form's required fields, as a page rendered today posts them. */
function form(extra: Record<string, string>): Record<string, string> {
  return { name: 'Kitchen', orientation: 'auto', rotation: '0', theme: 'panels', clock_24: '', ...extra };
}

function stored(): number | null {
  return (wall.db.prepare('SELECT motion AS m FROM screens WHERE id = ?').get(screenId) as { m: number | null }).m;
}

/** The document this wall is served, as text — the thing an ETag hashes. */
async function manifestText(): Promise<string> {
  return (await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`)).text();
}

/** Whether the settings page draws the switch on, and what it says it drew. */
async function drawnSwitch(): Promise<{ checked: boolean; shown: string | undefined }> {
  const html = await (await wall.call(`/admin/walls/${screenId}`)).text();
  const input = /<input type="checkbox" name="motion"[^>]*>/.exec(html)?.[0];
  expect(input, 'the Device and time pane has no Motion switch').toBeDefined();
  return {
    checked: /\schecked\b/.test(input as string),
    shown: /name="motion_shown" value="([01])"/.exec(html)?.[1],
  };
}

describe('what the column means', () => {
  const tv = WALL_SIZE_PRESETS.find((one) => one.key === 'tv-32');
  const eink = WALL_SIZE_PRESETS.filter((one) => one.eink === true);

  it('is on when never chosen, and off when never chosen on an e-ink size', () => {
    expect(wallMotion(null, null, null)).toBe(true);
    expect(wallMotion(undefined, undefined, undefined)).toBe(true);
    expect(wallMotion(null, tv?.widthMm, tv?.heightMm)).toBe(true);
    expect(eink.map((one) => one.key)).toEqual(['eink-7.5', 'eink-10.3', 'eink-13.3']);
    for (const preset of eink) {
      expect(wallMotion(null, preset.widthMm, preset.heightMm), preset.key).toBe(false);
      // Hung sideways, the pair is stored the other way round and is the same panel.
      expect(wallMotion(null, preset.heightMm, preset.widthMm), `${preset.key} sideways`).toBe(false);
    }
  });

  it('is what the household chose, whatever the size', () => {
    const panel = eink[0];
    expect(wallMotion(1, panel?.widthMm, panel?.heightMm)).toBe(true);
    expect(wallMotion(0, tv?.widthMm, tv?.heightMm)).toBe(false);
    expect(wallMotion(0, null, null)).toBe(false);
  });

  it('reads a size somebody typed as saying nothing about the kind of screen', () => {
    // 163x99 is a lit tablet the size of a 7.5" panel, not the panel.
    expect(wallMotion(null, 163, 99)).toBe(true);
  });
});

describe("a wall's Motion switch, through the settings form", () => {
  beforeAll(async () => {
    wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1) });
    screenId = await wall.pairWall('Kitchen');
  }, SLOW);

  afterAll(async () => {
    await wall.dispose();
  });

  it('starts unchosen, drawn on, and absent from the document', async () => {
    expect(stored()).toBeNull();
    expect(await drawnSwitch()).toEqual({ checked: true, shown: '1' });
    expect(await manifestText()).not.toContain('"motion"');
  });

  it('sits on Device and time, beside the size that decides its default', async () => {
    const html = await (await wall.call(`/admin/walls/${screenId}`)).text();
    const pane = html.slice(html.indexOf('data-wset-panel="device"'), html.indexOf('data-wset-panel="alerts"'));
    expect(pane.length, 'no Device and time pane found').toBeGreaterThan(100);
    expect(pane).toContain('name="motion"');
    expect(pane.indexOf('name="panel_size"')).toBeLessThan(pane.indexOf('name="motion"'));
  });

  it('leaves the column alone when the switch was not moved, so an e-ink size turns it off', async () => {
    // The switch was drawn on (a wall with no size) and is posted on: untouched.
    const saved = await wall.post(
      `/admin/screens/${screenId}`,
      form({ panel_size: 'eink-7.5', motion: '1', motion_shown: '1' }),
    );
    expect(saved.status).toBe(302);
    expect(stored(), 'an untouched switch wrote a choice nobody made').toBeNull();
    expect(JSON.parse(await manifestText()).screen.motion).toBe(false);
    expect(await drawnSwitch()).toEqual({ checked: false, shown: '0' });
  });

  it('writes the choice when the switch was moved, and the wall moves on an e-ink size', async () => {
    const saved = await wall.post(
      `/admin/screens/${screenId}`,
      form({ panel_size: 'eink-7.5', motion: '1', motion_shown: '0' }),
    );
    expect(saved.status).toBe(302);
    expect(stored()).toBe(1);
    expect(await manifestText()).not.toContain('"motion"');
    expect(await drawnSwitch()).toEqual({ checked: true, shown: '1' });
  });

  it('keeps an explicit choice through a save that did not touch it', async () => {
    // Size changed to a television, switch left as drawn.
    const saved = await wall.post(
      `/admin/screens/${screenId}`,
      form({ panel_size: 'tv-32', motion: '1', motion_shown: '1' }),
    );
    expect(saved.status).toBe(302);
    expect(stored()).toBe(1);
  });

  it('switched off, the document says the wall is still', async () => {
    // An unticked checkbox is not sent at all: this is the whole body of "off".
    const saved = await wall.post(`/admin/screens/${screenId}`, form({ panel_size: 'tv-32', motion_shown: '1' }));
    expect(saved.status).toBe(302);
    expect(stored()).toBe(0);
    expect(JSON.parse(await manifestText()).screen.motion).toBe(false);
  });

  it('a page rendered before the row existed changes nothing', async () => {
    const saved = await wall.post(`/admin/screens/${screenId}`, form({ panel_size: 'tv-32' }));
    expect(saved.status).toBe(302);
    expect(stored()).toBe(0);
  });
});
