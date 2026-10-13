/**
 * A module row's tone (plan item M7.2, contract 2), measured on a real paired
 * wall.
 *
 * A module says what a row is doing with a word — `active`, `alert` or `idle`
 * — and the wall draws it the way a Home Assistant tile draws its mark: the
 * row's picture knocked out of a circle in the theme's own state colour. What
 * is read is the computed colour, never a class: the circle's ground against
 * the page's own `--state-*`, and the picture in the row's ground. A row with
 * no tone has no circle and is the row it always was, and the circle costs
 * the row no height.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { createExternalModule } from '../src/api/external-modules.js';
import { readLayoutWidgets } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const PORTRAIT = { width: 1080, height: 1920 };

const PANEL = {
  kind: 'readings',
  title: 'Garden',
  items: [
    { label: 'Sprinkler', value: 'Running', glyph: 'switch', tone: 'active' },
    { label: 'Shed door', value: 'Open', glyph: 'door', tone: 'alert' },
    { label: 'Soil', value: 'Damp', glyph: 'moisture', tone: 'idle' },
    { label: 'Pond', value: 'Full', tone: 'alert' },
    { label: 'Gate', value: 'Shut', glyph: 'door' },
  ],
};

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({});
  equipHousehold(wall.db, wall.now());
  createExternalModule(wall.db, { id: 'garden', url: 'http://127.0.0.1:1', name: 'Garden' });
  wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = 'garden'`).run(
    JSON.stringify(PANEL),
    wall.now(),
  );
  const screenId = await wall.pairWall('Kitchen');
  const classic = readLayoutWidgets(wall.db, screenId, 'portrait');
  const aspects = wall.db.prepare('SELECT layout_aspect AS p FROM screens WHERE id = ?').get(screenId) as { p: number };
  const widgets = [
    ...classic.map((row) => ({
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ...(row.config !== null && typeof row.config === 'object' && Object.keys(row.config).length > 0
        ? { config: row.config }
        : {}),
    })),
    { id: 'garden-box', type: 'external', x: 0.05, y: 0.05, w: 0.6, h: 0.3, z: 100, config: { module: 'garden' } },
  ];
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspects.p, widgets }),
  });
  expect(saved.status).toBe(200);
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

describe('a module row’s tone on the wall', () => {
  it(
    'draws a toned row’s picture in a circle of the theme’s state colour, and leaves an untoned row as it was',
    async () => {
      const opened = await loadWallSettled(link, PORTRAIT);
      try {
        const rows = await opened.page.evaluate(() => {
          const box = document.querySelector<HTMLElement>('#wall .canvas .fw[data-widget-id="garden-box"]');
          if (box === null) throw new Error('no module box');
          const colourOf = (value: string): string => {
            const probe = document.createElement('span');
            probe.style.color = value;
            box.appendChild(probe);
            const out = getComputedStyle(probe).color;
            probe.remove();
            return out;
          };
          const states = {
            active: colourOf('var(--state-active)'),
            alert: colourOf('var(--state-alert)'),
            idle: colourOf('var(--state-idle)'),
          };
          return {
            states,
            rows: Array.from(box.querySelectorAll<HTMLElement>('.gp-reading')).map((row) => {
              const circle = row.querySelector<HTMLElement>('.gp-circle');
              const mark = circle?.querySelector('svg') ?? null;
              const label = row.querySelector<HTMLElement>('.gp-label');
              const rowRect = row.getBoundingClientRect();
              const circleRect = circle?.getBoundingClientRect();
              return {
                label: label?.textContent ?? '',
                circle: circle === null ? null : getComputedStyle(circle).backgroundColor,
                round: circle === null ? null : getComputedStyle(circle).borderRadius,
                mark: mark === null ? null : getComputedStyle(mark).color,
                ground: getComputedStyle(row).color === '' ? null : colourOf('var(--bg)'),
                plainGlyph: row.querySelector('.gp-ico') !== null,
                inside:
                  circleRect === undefined ||
                  (circleRect.top >= rowRect.top - 0.5 && circleRect.bottom <= rowRect.bottom + 0.5),
                labelHeight: label?.getBoundingClientRect().height ?? 0,
                height: rowRect.height,
              };
            }),
          };
        });
        const [sprinkler, shed, soil, pond, gate] = rows.rows;
        expect(rows.rows.map((row) => row.label)).toEqual(['Sprinkler', 'Shed door', 'Soil', 'Pond', 'Gate']);
        // The circle is the tone, in the theme's own colour for it.
        expect(sprinkler?.circle).toBe(rows.states.active);
        expect(shed?.circle).toBe(rows.states.alert);
        expect(soil?.circle).toBe(rows.states.idle);
        expect(pond?.circle).toBe(rows.states.alert);
        // Three different colours, so the test is not passing on one shared ground.
        expect(new Set([rows.states.active, rows.states.alert, rows.states.idle]).size).toBe(3);
        // Round, and the picture knocked out in the row's ground.
        expect(sprinkler?.round).toBe('50%');
        expect(sprinkler?.mark).toBe(sprinkler?.ground);
        // A tone with no picture is the circle alone.
        expect(pond?.mark).toBeNull();
        // No tone: no circle, and the picture where it always was.
        expect(gate?.circle).toBeNull();
        expect(gate?.plainGlyph).toBe(true);
        // The circle sits inside its row, and costs it no height: every row is
        // the height its words make it.
        for (const row of rows.rows) expect(row.inside).toBe(true);
        const heights = rows.rows.map((row) => Math.round(row.height));
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
