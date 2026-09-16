import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUSEHOLD_CALENDARS, install, type Installation } from './browser-harness.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';

/**
 * The wall's default style lane, through the settings form (RFC 014 §4.1 /
 * §4.4): the colours, faces, weight, tracking and inset every widget on a
 * wall starts from, saved by the same form that saves its theme and gutter.
 *
 * Three properties, and the first is the one a colour input makes hard:
 *
 *  - **Only what differs from the theme is kept.** A colour input always
 *    posts a value, so a handler that wrote every field back would freeze all
 *    eleven colours onto the wall the first time somebody changed one — and
 *    the daylight theme would never reach them again.
 *  - **Inherit on is no lane**, and a page rendered before the row existed
 *    (no `style_form` marker) leaves the column exactly as it found it — the
 *    gutter's rule one group up.
 *  - **The lane's schema is the boundary**: a face off the allowlist is a 400
 *    with its own message, never coerced, and the manifest then carries the
 *    stored lane resolved.
 */

process.env['TZ'] = 'UTC';
const SLOW = 120_000;

let wall: Installation;
let screenId: string;

const PANELS = BUILTIN_THEME_TOKENS.panels;

/** The settings form's required fields, as a page rendered today posts them. */
function base(extra: Record<string, string>): Record<string, string> {
  return {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: 'panels',
    clock_24: '',
    layout_gutter: '4',
    style_form: '1',
    style_bg: PANELS['--bg'].toLowerCase(),
    style_panel: PANELS['--panel'].toLowerCase(),
    style_rule: PANELS['--rule'].toLowerCase(),
    style_ink: PANELS['--ink'].toLowerCase(),
    style_muted: PANELS['--muted'].toLowerCase(),
    style_faint: PANELS['--faint'].toLowerCase(),
    style_accent: PANELS['--accent'].toLowerCase(),
    style_s_day: PANELS['--s-day'].toLowerCase(),
    style_s_night: PANELS['--s-night'].toLowerCase(),
    style_s_break: PANELS['--s-break'].toLowerCase(),
    style_s_straight: PANELS['--s-straight'].toLowerCase(),
    style_disp: '',
    style_f_sans: '',
    style_weight: 'regular',
    style_tracking: 'normal',
    style_inset: '4',
    ...extra,
  };
}

function stored(): string | null {
  return (wall.db.prepare('SELECT layout_style AS s FROM screens WHERE id = ?').get(screenId) as { s: string | null }).s;
}

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1) });
  screenId = await wall.pairWall('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall.dispose();
});

describe('the wall’s default style lane', () => {
  it('starts as no lane, and the settings page offers the theme’s own colours behind the switch', async () => {
    expect(stored()).toBeNull();
    const html = await (await wall.call(`/admin/walls/${screenId}`)).text();
    expect(html).toContain('Colours and type');
    expect(html).toContain('name="style_inherit"');
    expect(html).toContain('checked');
    // Seeded from the theme the wall wears, and disabled while inheriting, so
    // a save with the switch on posts none of them.
    expect(html).toMatch(new RegExp(`name="style_bg" value="${PANELS['--bg']}"[^>]*disabled`));
    expect(html).toMatch(new RegExp(`name="style_accent" value="${PANELS['--accent']}"[^>]*disabled`));
  });

  it('keeps only what differs from the theme, so an untouched colour still follows it', async () => {
    const saved = await wall.post(`/admin/screens/${screenId}`, base({ style_accent: '#ff0000', style_weight: 'bold' }));
    expect(saved.status).toBe(302);
    expect(JSON.parse(stored() ?? 'null')).toEqual({ '--accent': '#ff0000', weight: 'bold' });
  });

  it('reaches the manifest resolved, on the canvas and beneath every widget', async () => {
    const response = await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`);
    const manifest = (await response.json()) as { screen: { layoutStyleTokens?: Record<string, string> } };
    expect(manifest.screen.layoutStyleTokens).toEqual({ '--accent': '#ff0000', 'font-weight': '700' });
  });

  it('a page rendered before the row existed leaves the lane exactly as it found it', async () => {
    const stale = base({});
    delete stale['style_form'];
    for (const key of Object.keys(stale)) if (key.startsWith('style_')) delete stale[key];
    const saved = await wall.post(`/admin/screens/${screenId}`, stale);
    expect(saved.status).toBe(302);
    expect(JSON.parse(stored() ?? 'null')).toEqual({ '--accent': '#ff0000', weight: 'bold' });
  });

  it('refuses a face off the allowlist with the lane’s own sentence, and writes nothing', async () => {
    const refused = await wall.post(`/admin/screens/${screenId}`, base({ style_disp: 'Comic Sans, cursive' }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Choose a font from the list');
    expect(JSON.parse(stored() ?? 'null')).toEqual({ '--accent': '#ff0000', weight: 'bold' });
  });

  it('inherit on is no lane again', async () => {
    const saved = await wall.post(`/admin/screens/${screenId}`, { ...base({}), style_inherit: '1' });
    expect(saved.status).toBe(302);
    expect(stored()).toBeNull();
    const response = await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`);
    expect(await response.text()).not.toContain('layoutStyleTokens');
  });
});
