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
  it('all thirteen validate against the same schema a hand-built canvas does', () => {
    expect(TEMPLATES).toHaveLength(13);
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
      // "Require both" (RFC 005): a template-started display is never one-sided.
      expect(t.portrait.widgets.length, `${t.id} portrait`).toBeGreaterThan(0);
      expect(t.landscape.widgets.length, `${t.id} landscape`).toBeGreaterThan(0);
    }
  });

  it('every template names a built-in theme and gives both canvases a background (Phase 3c)', () => {
    for (const t of TEMPLATES) {
      // Classic is the exception, deliberately: it is the universal default every
      // wall is migrated onto, so it sets no theme and no background and keeps
      // whatever the wall already has (see templates/classic.ts).
      if (t.id === 'classic') {
        expect(t.theme, 'classic theme').toBeUndefined();
        expect(t.portrait.background, 'classic portrait bg').toBeUndefined();
        expect(t.landscape.background, 'classic landscape bg').toBeUndefined();
        continue;
      }
      expect(['household', 'blueprint', 'panels', 'almanac'], t.id).toContain(t.theme);
      expect(t.portrait.background, `${t.id} portrait bg`).toBeDefined();
      expect(t.landscape.background, `${t.id} landscape bg`).toBeDefined();
    }
  });

  it('leads the gallery with Classic, then the two Skylight-style clones', () => {
    expect(TEMPLATES[0]?.id).toBe('classic');
    expect(TEMPLATES[1]?.id).toBe('sky-calendar');
    expect(TEMPLATES[2]?.id).toBe('sky-week');
    // The whole reason 1a existed: Sky Calendar draws month pills, Sky Week draws columns.
    const skyCalendarCal = TEMPLATES[1]?.portrait.widgets.find((w) => w.type === 'calendar');
    expect(skyCalendarCal?.config).toMatchObject({ cellEvents: 'pills' });
    const skyWeekCols = TEMPLATES[2]?.portrait.widgets.find(
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

  it('sets the template theme and per-orientation backgrounds (Phase 3c)', () => {
    const d = db();
    const sky = findTemplate('sky-calendar')!;
    applyTemplate(d, null, sky);
    const row = d
      .prepare(
        `SELECT theme, layout_background AS p, layout_landscape_background AS l FROM household_settings`,
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

describe('copying a layout from another display', () => {
  it('copies both canvases onto the target with fresh ids, leaving the source intact', () => {
    const d = db();
    const at = Date.now();
    d.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('wallA','Kitchen','h',?,?,?)`,
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
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('wallB','Hall','h',?,?,?)`,
    ).run(at, at, at);
    // The default has never been arranged — copying it must not invent a canvas.
    copyLayout(d, null, 'wallB');
    expect(readLayoutWidgets(d, 'wallB', 'portrait')).toHaveLength(0);
    const mode = (d.prepare(`SELECT layout_mode AS m FROM screens WHERE id='wallB'`).get() as { m: string }).m;
    expect(mode).toBe('auto');
  });
});
