import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { applyTemplate, copyLayout, findTemplate, templateSchema } from '../src/api/templates.js';
import { TEMPLATES } from '../src/templates/index.js';
import { WALLPAPERS, backgroundForTone } from '../src/wallpapers.js';

/**
 * The starting-layout templates (RFC 005).
 *
 * A template is data, and the point is that what ships is real and well-formed —
 * so the test that matters is that every shipped template validates against the
 * *same* schema a hand-written canvas does (a template can place nothing a
 * household could not), and that applying one lands a real, drawable canvas for
 * both orientations. A malformed template must fail here, not on a wall.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function db() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-templates-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(at, at);
  return db;
}

describe('the shipped templates', () => {
  it('all of them validate against the same schema a hand-built canvas does', () => {
    // Counted off the list rather than pinned to a literal: the number was 13
    // and is 14 with Blank, and a hardcoded count only ever fails the commit
    // that adds a card, which is the one commit that already knows.
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const template of TEMPLATES) {
      const parsed = templateSchema.safeParse(template);
      expect(parsed.success, `${template.id}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('every template has a unique, kebab-case id and authors both orientations', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.id, t.id).toMatch(/^[a-z0-9-]+$/);
      /*
       * "Require both" (RFC 005): a template-started display is never one-sided.
       *
       * Stated as *agreement between the two canvases* rather than as "each has
       * widgets", which is what it used to say. Blank has none in either, on
       * purpose, and an exception naming it would have been the weaker test —
       * the letterbox fault this guards against is a card that places boxes in
       * one orientation and not the other, and that is now what it asks. Both
       * canvases are still authored: each carries an aspect the schema bounds.
       */
      expect(t.portrait.widgets.length > 0, `${t.id}: one orientation is empty and the other is not`).toBe(
        t.landscape.widgets.length > 0,
      );
      expect(t.portrait.aspect, `${t.id} portrait aspect`).toBeGreaterThan(0);
      expect(t.landscape.aspect, `${t.id} landscape aspect`).toBeGreaterThan(0);
    }
  });

  it('every template names a built-in theme and gives both canvases a background (Phase 3c)', () => {
    for (const t of TEMPLATES) {
      /*
       * Three exceptions, and they are one reason three times: a card that
       * must not repaint the wall it is applied to. Classic is the universal
       * default every wall is migrated onto, Blank is an empty canvas, and
       * Classic Strip is Classic's own arrangement with its utilities in one
       * group (RFC 014 §5.1) — a household pressing any of them is asking
       * about *arrangement*, and taking their chosen theme off the wall is not
       * something any of those words promises. All three set no theme and no
       * background and keep whatever the wall already has.
       */
      if (t.id === 'classic' || t.id === 'blank' || t.id === 'classic-strip') {
        expect(t.theme, `${t.id} theme`).toBeUndefined();
        expect(t.portrait.background, `${t.id} portrait bg`).toBeUndefined();
        expect(t.landscape.background, `${t.id} landscape bg`).toBeUndefined();
        continue;
      }
      /*
       * Two more keep the wall's theme, and for the picture's reason rather
       * than the arrangement's (plan items M4.9 and M4.12). Photo Frame's
       * painting is fitted to the wall's tone when it is applied, so it needs
       * no theme to be legible under; Mosaic's pictures are the household's
       * own tiles, and it has no canvas background at all.
       */
      if (t.id === 'photo-frame' || t.id === 'mosaic') {
        expect(t.theme, `${t.id} theme`).toBeUndefined();
        if (t.id === 'photo-frame') {
          expect(t.portrait.background?.type, `${t.id} portrait bg`).toBe('rotation');
          expect(t.landscape.background?.type, `${t.id} landscape bg`).toBe('rotation');
        } else {
          expect(t.portrait.background, `${t.id} portrait bg`).toBeUndefined();
          expect(t.landscape.background, `${t.id} landscape bg`).toBeUndefined();
        }
        continue;
      }
      expect(['household', 'blueprint', 'panels', 'almanac'], t.id).toContain(t.theme);
      expect(t.portrait.background, `${t.id} portrait bg`).toBeDefined();
      expect(t.landscape.background, `${t.id} landscape bg`).toBeDefined();
    }
  });

  it('leads the gallery with Blank and Classic, then the two Skylight-style clones', () => {
    /*
     * Blank leads. Every card in this gallery was somebody else's arrangement,
     * so a household who wanted to build their own had to pick the nearest and
     * delete its boxes — starting from nothing was the one thing a gallery of
     * starting points could not do. Classic still follows it, and is still what
     * a new wall is *selected* on: first in the list and preselected are two
     * different jobs, and defaulting a new wall to Blank would hand somebody a
     * blank kitchen calendar.
     */
    expect(TEMPLATES[0]?.id).toBe('blank');
    expect(TEMPLATES[1]?.id).toBe('classic');
    expect(TEMPLATES[2]?.id).toBe('sky-calendar');
    expect(TEMPLATES[3]?.id).toBe('sky-week');
    // The whole reason 1a existed: Sky Calendar draws month pills, Sky Week draws columns.
    const skyCalendarCal = TEMPLATES[2]?.portrait.widgets.find((w) => w.type === 'calendar');
    expect(skyCalendarCal?.config).toMatchObject({ cellEvents: 'pills' });
    const skyWeekCols = TEMPLATES[3]?.portrait.widgets.find(
      (w) => w.type === 'calendar' && (w.config as { mode?: string })?.mode === 'week',
    );
    expect(skyWeekCols).toBeDefined();
  });

  it('rejects a template with a web-embed widget — rule three, at the source', () => {
    const bad = {
      id: 'evil',
      name: 'Evil',
      category: 'home',
      blurb: 'x',
      portrait: { aspect: 0.5625, widgets: [{ type: 'website', x: 0, y: 0, w: 1, h: 1 }] },
      landscape: { aspect: 1.7778, widgets: [{ type: 'clock', x: 0, y: 0, w: 1, h: 1 }] },
    };
    expect(templateSchema.safeParse(bad).success).toBe(false);
  });

  it('finds a template by id, and misses cleanly', () => {
    expect(findTemplate('family-hub')?.name).toBe('Family Hub');
    expect(findTemplate('nope')).toBeUndefined();
    expect(findTemplate('')).toBeUndefined();
  });
});

describe('applying a template', () => {
  it('writes both canvases as free-form, with minted ids', () => {
    const d = db();
    const sky = findTemplate('sky-calendar')!;
    applyTemplate(d, null, sky);

    const portrait = readLayoutWidgets(d, null, 'portrait');
    const landscape = readLayoutWidgets(d, null, 'landscape');
    expect(portrait.map((w) => w.type)).toEqual(sky.portrait.widgets.map((w) => w.type));
    expect(landscape.map((w) => w.type)).toEqual(sky.landscape.widgets.map((w) => w.type));
    // Ids are minted, not carried, so two displays never share them.
    expect(portrait.every((w) => /^w[0-9a-f]+$/.test(w.id))).toBe(true);
    expect(new Set([...portrait, ...landscape].map((w) => w.id)).size).toBe(
      portrait.length + landscape.length,
    );

    const mode = (d.prepare(`SELECT layout_mode AS m FROM household_settings`).get() as { m: string }).m;
    expect(mode).toBe('freeform');
    const aspects = d
      .prepare(`SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM household_settings`)
      .get() as { p: number; l: number };
    expect(aspects).toEqual({ p: sky.portrait.aspect, l: sky.landscape.aspect });
  });

  it('sets the template theme and per-orientation backgrounds on a wall (Phase 3c)', () => {
    // On a *wall*: the household row has no theme to set any more (RFC 015
    // phase 2), so a template's theme reaches the screen it is applied to.
    const d = db();
    const at = Date.now();
    d.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('wallT', 'Kitchen', 'h', 'panels', ?, ?, ?)`,
    ).run(at, at, at);
    const sky = findTemplate('sky-calendar')!;
    applyTemplate(d, 'wallT', sky);
    const row = d
      .prepare(
        `SELECT theme, layout_background AS p, layout_landscape_background AS l FROM screens WHERE id = 'wallT'`,
      )
      .get() as { theme: string; p: string; l: string };
    expect(row.theme).toBe('almanac');
    // Stored as JSON, and it is the template's own background.
    expect(JSON.parse(row.p)).toEqual(sky.portrait.background);
    expect(JSON.parse(row.l)).toEqual(sky.landscape.background);
  });

  it('carries a widget config through — the pills option lands on the wall', () => {
    const d = db();
    applyTemplate(d, null, findTemplate('sky-calendar')!);
    const cal = readLayoutWidgets(d, null, 'portrait').find((w) => w.type === 'calendar');
    expect(cal?.config).toEqual({ cellEvents: 'pills' });
  });

  it('replaces the display it is applied to, and re-minting ids stays distinct', () => {
    const d = db();
    applyTemplate(d, null, findTemplate('family-hub')!);
    const first = readLayoutWidgets(d, null, 'portrait').map((w) => w.id);
    applyTemplate(d, null, findTemplate('reception')!);
    const second = readLayoutWidgets(d, null, 'portrait');
    // A fresh template fully replaced the last one — no leftovers, new ids.
    expect(second.map((w) => w.type)).toEqual(
      findTemplate('reception')!.portrait.widgets.map((w) => w.type),
    );
    expect(second.some((w) => first.includes(w.id))).toBe(false);
  });
});

describe('a template fitted to the wall it lands on (plan items M4.9 and M4.12)', () => {
  function wall(d: ReturnType<typeof db>, id: string, theme: string): void {
    const at = Date.now();
    d.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, `h-${id}`, theme, at, at, at);
  }
  function backgrounds(d: ReturnType<typeof db>, id: string): { p: unknown; l: unknown } {
    const row = d
      .prepare(`SELECT layout_background AS p, layout_landscape_background AS l FROM screens WHERE id = ?`)
      .get(id) as { p: string | null; l: string | null };
    return { p: row.p === null ? null : JSON.parse(row.p), l: row.l === null ? null : JSON.parse(row.l) };
  }

  it('keeps the dark paintings on a dark wall and takes the light ones on a light wall', () => {
    const d = db();
    wall(d, 'dark', 'panels');
    wall(d, 'light', 'almanac');
    const frame = findTemplate('photo-frame')!;
    applyTemplate(d, 'dark', frame);
    applyTemplate(d, 'light', frame);
    expect(backgrounds(d, 'dark').p).toMatchObject({ type: 'rotation', collection: 'painting', tone: 'dark' });
    expect(backgrounds(d, 'light').p).toMatchObject({ type: 'rotation', collection: 'painting', tone: 'light' });
    expect(backgrounds(d, 'light').l).toMatchObject({ tone: 'light' });
    // It names no theme, so the wall keeps its own.
    const theme = (d.prepare(`SELECT theme FROM screens WHERE id = 'light'`).get() as { theme: string }).theme;
    expect(theme).toBe('almanac');
  });

  it('fits the tone to the theme chosen at creation, not the one the row held', () => {
    const d = db();
    wall(d, 'w', 'panels');
    applyTemplate(d, 'w', findTemplate('photo-frame')!, undefined, 'household');
    expect(backgrounds(d, 'w').p).toMatchObject({ tone: 'light' });
  });

  it('writes the gutter and the ground a template names, and leaves them where it names none', () => {
    const d = db();
    wall(d, 'm', 'panels');
    d.prepare(`UPDATE screens SET layout_gutter = 5, widget_ground = 'glass' WHERE id = 'm'`).run();
    applyTemplate(d, 'm', findTemplate('classic')!);
    const kept = d.prepare(`SELECT layout_gutter AS g, widget_ground AS w FROM screens WHERE id = 'm'`).get();
    expect(kept).toEqual({ g: 5, w: 'glass' });
    applyTemplate(d, 'm', findTemplate('mosaic')!);
    const mosaic = d.prepare(`SELECT layout_gutter AS g, widget_ground AS w FROM screens WHERE id = 'm'`).get();
    expect(mosaic).toEqual({ g: 0, w: 'solid' });
  });

  it('swaps a single wallpaper for one of the same kind in the wall\'s tone', () => {
    const one = WALLPAPERS.find((w) => w.tone === 'dark')!;
    const swapped = backgroundForTone({ type: 'wallpaper', id: one.id }, 'light');
    const picked = WALLPAPERS.find((w) => w.id === (swapped as { id: string }).id)!;
    expect(picked.tone).toBe('light');
    expect(backgroundForTone({ type: 'wallpaper', id: one.id }, 'dark')).toEqual({ type: 'wallpaper', id: one.id });
    expect(backgroundForTone({ type: 'solid', color: '#112233' }, 'light')).toEqual({ type: 'solid', color: '#112233' });
  });
});

describe('copying a layout from another display', () => {
  it('copies both canvases onto the target with fresh ids, leaving the source intact', () => {
    const d = db();
    const at = Date.now();
    d.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('wallA', 'Kitchen', 'h', 'panels',?,?,?)`,
    ).run(at, at, at);

    // The default gets a template; copy it onto the Kitchen wall.
    applyTemplate(d, null, findTemplate('sky-week')!);
    copyLayout(d, null, 'wallA');

    const defaultPortrait = readLayoutWidgets(d, null, 'portrait');
    const kitchenPortrait = readLayoutWidgets(d, 'wallA', 'portrait');
    const kitchenLandscape = readLayoutWidgets(d, 'wallA', 'landscape');

    expect(kitchenPortrait.map((w) => w.type)).toEqual(defaultPortrait.map((w) => w.type));
    expect(kitchenLandscape.length).toBeGreaterThan(0);
    // Fresh ids, so editing one wall's canvas never touches the other's rows.
    expect(kitchenPortrait.some((w) => defaultPortrait.map((x) => x.id).includes(w.id))).toBe(false);
    // The Kitchen now owns a free-form canvas of its own.
    const kMode = (d.prepare(`SELECT layout_mode AS m FROM screens WHERE id='wallA'`).get() as { m: string }).m;
    expect(kMode).toBe('freeform');
    // The source default is untouched.
    expect(readLayoutWidgets(d, null, 'portrait').map((w) => w.type)).toEqual(
      defaultPortrait.map((w) => w.type),
    );
  });

  it('copies an empty (auto) source as auto, drawing nothing of its own', () => {
    const d = db();
    const at = Date.now();
    d.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('wallB', 'Hall', 'h', 'panels',?,?,?)`,
    ).run(at, at, at);
    // The default has never been arranged — copying it must not invent a canvas.
    copyLayout(d, null, 'wallB');
    expect(readLayoutWidgets(d, 'wallB', 'portrait')).toHaveLength(0);
    const mode = (d.prepare(`SELECT layout_mode AS m FROM screens WHERE id='wallB'`).get() as { m: string }).m;
    expect(mode).toBe('auto');
  });
});
