import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { install, type Installation } from './browser-harness.js';

/**
 * A wall's Widget ground (plan item P6.3), from the settings form to the
 * document a wall reads.
 *
 * `wall-motion.test.ts`'s three properties, one control along, because the
 * control has the same shape of default: **never chosen follows the
 * background** — Soft on a wall with a wallpaper, None anywhere else — so the
 * segment drawn checked on an unchosen wall is a reading of the default, and
 * a handler that stored whatever arrived would freeze it the first time
 * somebody saved a timezone. The form says what it drew
 * (`widget_ground_shown`) and the handler writes only a move.
 *
 * The wall resolves the default itself (`widgetGroundFor`, unit-tested in the
 * display) and `browser-wallpaper.test.ts` measures what it paints; this is
 * the column and the document.
 */

let wall: Installation;
let screenId: string;

beforeAll(async () => {
  wall = await install();
  screenId = await wall.pairWall('Kitchen');
}, 60_000);

afterAll(async () => {
  await wall.dispose();
});

function form(extra: Record<string, string>): Record<string, string> {
  return { name: 'Kitchen', orientation: 'auto', rotation: '0', theme: 'panels', clock_24: '', ...extra };
}

function stored(): string | null {
  return (wall.db.prepare('SELECT widget_ground AS g FROM screens WHERE id = ?').get(screenId) as { g: string | null }).g;
}

async function manifestText(): Promise<string> {
  return (await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`)).text();
}

/** Which segment the Layout settings draw checked, and what they say they drew. */
async function drawn(): Promise<{ checked: string | undefined; shown: string | undefined }> {
  const html = await (await wall.call(`/admin/walls/${screenId}`)).text();
  const checked = /<input type="radio" name="widget_ground" value="(none|soft|solid)" checked>/.exec(html)?.[1];
  return { checked, shown: /name="widget_ground_shown" value="([a-z]+)"/.exec(html)?.[1] };
}

describe("a wall's Widget ground, through the settings form", () => {
  it('starts unchosen: None on a wall with no wallpaper, and absent from the document', async () => {
    expect(stored()).toBeNull();
    expect(await drawn()).toEqual({ checked: 'none', shown: 'none' });
    expect(await manifestText()).not.toContain('"widgetGround"');
  });

  it('reads Soft once a wallpaper is on the wall, still without writing anything', async () => {
    wall.db
      .prepare('UPDATE screens SET layout_landscape_background = ? WHERE id = ?')
      .run('{"type":"wallpaper","id":"dusk"}', screenId);
    expect(await drawn()).toEqual({ checked: 'soft', shown: 'soft' });
    // An untouched control posted back as drawn changes nothing.
    const saved = await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'soft', widget_ground_shown: 'soft' }));
    expect(saved.status).toBe(302);
    expect(stored(), 'an untouched control wrote a choice nobody made').toBeNull();
    expect(await manifestText()).not.toContain('"widgetGround"');
  });

  it('writes a move, and the document says it', async () => {
    const saved = await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'solid', widget_ground_shown: 'soft' }));
    expect(saved.status).toBe(302);
    expect(stored()).toBe('solid');
    expect(JSON.parse(await manifestText()).screen.widgetGround).toBe('solid');
    expect(await drawn()).toEqual({ checked: 'solid', shown: 'solid' });
  });

  it('keeps a choice through a save that did not touch it, and through a page that predates the row', async () => {
    await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'solid', widget_ground_shown: 'solid' }));
    expect(stored()).toBe('solid');
    await wall.post(`/admin/screens/${screenId}`, form({}));
    expect(stored()).toBe('solid');
  });

  it('chooses None over a wallpaper, which is a choice rather than the default', async () => {
    await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'none', widget_ground_shown: 'solid' }));
    expect(stored()).toBe('none');
    expect(JSON.parse(await manifestText()).screen.widgetGround).toBe('none');
  });

  it('refuses a ground that is not one of the three (rule five)', async () => {
    const refused = await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'opaque', widget_ground_shown: 'none' }));
    expect(refused.status).toBe(400);
    expect(stored()).toBe('none');
  });
});
