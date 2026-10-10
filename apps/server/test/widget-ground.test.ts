import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { install, type Installation } from './browser-harness.js';
import { WALLPAPER_GLASS } from '../src/wallpaper-glass.js';

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
  const checked = /<input type="radio" name="widget_ground" value="(none|soft|solid|glass)" checked>/.exec(html)?.[1];
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

  it('offers Glass as a fourth ground, without asking a flag (plan item M4.3)', async () => {
    expect(await (await wall.call(`/admin/walls/${screenId}`)).text()).toContain('value="glass"');
    const saved = await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'glass', widget_ground_shown: 'none' }));
    expect(saved.status).toBe(302);
    expect(stored()).toBe('glass');
    expect(JSON.parse(await manifestText()).screen.widgetGround).toBe('glass');
    expect((await drawn()).checked).toBe('glass');
    await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'none', widget_ground_shown: 'glass' }));
    expect(stored()).toBe('none');
  });

  it('refuses a ground that is not one of the four (rule five)', async () => {
    const refused = await wall.post(`/admin/screens/${screenId}`, form({ widget_ground: 'opaque', widget_ground_shown: 'none' }));
    expect(refused.status).toBe(400);
    expect(stored()).toBe('none');
  });
});

describe('Glass on its own wall (plan items M4.1–M4.3)', () => {
  let glassy: Installation;
  let id: string;
  beforeAll(async () => {
    glassy = await install();
    id = await glassy.pairWall('Hall');
  }, 60_000);
  afterAll(async () => {
    await glassy.dispose();
  });

  it('is offered as a fourth ground, says what it does, and is stored and sent', async () => {
    const page = await (await glassy.call(`/admin/walls/${id}`)).text();
    expect(page).toContain('value="glass"');
    expect(page).toContain('Glass blurs the picture behind each widget');
    expect(page).not.toContain('prototype');
    const saved = await glassy.post(`/admin/screens/${id}`, form({ widget_ground: 'glass', widget_ground_shown: 'none' }));
    expect(saved.status).toBe(302);
    expect((glassy.db.prepare('SELECT widget_ground AS g FROM screens WHERE id = ?').get(id) as { g: string }).g).toBe('glass');
    const sent = JSON.parse(await (await glassy.call(`/admin/layout/preview.json?screen=${encodeURIComponent(id)}`)).text());
    expect(sent.screen.widgetGround).toBe('glass');
  });

  it('sends each wallpaper what it shows through Glass to a wall on Glass, and to no other wall (plan item M4.2)', async () => {
    const preview = async (): Promise<{ screen: { widgetGround?: string }; layout: { portrait: { background?: Record<string, unknown> } } }> =>
      JSON.parse(await (await glassy.call(`/admin/layout/preview.json?screen=${encodeURIComponent(id)}`)).text());
    glassy.db.prepare(`UPDATE screens SET layout_background = '{"type":"wallpaper","id":"dusk"}', widget_ground = 'glass' WHERE id = ?`).run(id);
    expect((await preview()).layout.portrait.background?.['glass']).toEqual({ light: WALLPAPER_GLASS['dusk']?.light, dark: WALLPAPER_GLASS['dusk']?.dark });
    // A rotation carries it on every picture.
    glassy.db
      .prepare(`UPDATE screens SET layout_background = '{"type":"rotation","collection":"gradient","tone":"dark","every":60}' WHERE id = ?`)
      .run(id);
    const pictures = (await preview()).layout.portrait.background?.['pictures'] as { id: string; glass?: unknown }[];
    expect(pictures.length).toBeGreaterThan(1);
    for (const one of pictures) expect(one.glass).toEqual({ light: WALLPAPER_GLASS[one.id]?.light, dark: WALLPAPER_GLASS[one.id]?.dark });
    // Soft: the wallpaper as it always was, with no Glass on it.
    glassy.db.prepare(`UPDATE screens SET layout_background = '{"type":"wallpaper","id":"dusk"}', widget_ground = 'soft' WHERE id = ?`).run(id);
    expect(JSON.stringify((await preview()).layout.portrait.background)).not.toContain('glass');
  });
});
