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
 *
 * And progress (plan item M7.3): a row's bar is filled to its number, in its
 * tone or the accent, and costs the row no height; a gauge's ring is wound to
 * its number, and the words in it are never larger than a clock may be and
 * stay inside the ring.
 *
 * And series and tables (plan item M7.4): a row's line of numbers sits in one
 * slot at the end of every row once any row has one, so values end at one
 * edge; a table's cells line up in fixed columns, a long cell wraps rather than
 * being cut, and a box too short for every row gives up whole rows.
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
import { panelDataSchema } from '../src/modules/external/panel-data.js';
import { readLayoutWidgets } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const PORTRAIT = { width: 1080, height: 1920 };

const PANEL = {
  kind: 'readings',
  title: 'Garden',
  items: [
    { label: 'Sprinkler', value: 'Running', glyph: 'switch', tone: 'active', progress: 45 },
    { label: 'Shed door', value: 'Open', glyph: 'door', tone: 'alert' },
    { label: 'Soil', value: 'Damp', glyph: 'moisture', tone: 'idle', series: [30, 32, null, 35, 33, 31] },
    { label: 'Pond', value: 'Full', tone: 'alert' },
    { label: 'Gate', value: 'Shut', glyph: 'door' },
    { label: 'Backup', value: 'Done', progress: 100 },
  ],
};

const GAUGE = { kind: 'gauge', title: 'Water butt', label: 'Full', value: '72%', progress: 72, tone: 'idle' };
const LONG = { kind: 'gauge', label: 'Rooms tidied', value: '3 of 8 rooms done', progress: 37.5 };
const TRAINS = {
  kind: 'table',
  title: 'Trains',
  columns: ['To', 'Due', 'Platform'],
  rows: [
    ['London Bridge via Redhill and Croydon', '08:12', '2'],
    ['Brighton', '08:20', '1'],
    ['Lewes', '08:31', '4'],
  ],
};
const MANY = {
  kind: 'table',
  columns: ['Bin', 'Day'],
  rows: Array.from({ length: 12 }, (_, i) => [`Bin ${i + 1}`, 'Tuesday']),
};

let wall: Installation;
let link: string;

beforeAll(async () => {
  // Every panel here is written straight to the store, past the poll that
  // would have refused it — so each is held to the schema first, or a fixture
  // the server would never accept could pass for a wall drawing it.
  for (const panel of [PANEL, GAUGE, LONG, TRAINS, MANY]) panelDataSchema.parse(panel);
  wall = await install({});
  equipHousehold(wall.db, wall.now());
  createExternalModule(wall.db, { id: 'garden', url: 'http://127.0.0.1:1', name: 'Garden' });
  wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = 'garden'`).run(
    JSON.stringify(PANEL),
    wall.now(),
  );
  createExternalModule(wall.db, { id: 'butt', url: 'http://127.0.0.1:1', name: 'Water butt' });
  wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = 'butt'`).run(
    JSON.stringify(GAUGE),
    wall.now(),
  );
  for (const [id, panel] of [['trains', TRAINS], ['many', MANY]] as const) {
    createExternalModule(wall.db, { id, url: 'http://127.0.0.1:1', name: id });
    wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = ?`).run(
      JSON.stringify(panel),
      wall.now(),
      id,
    );
  }
  createExternalModule(wall.db, { id: 'rooms', url: 'http://127.0.0.1:1', name: 'Rooms' });
  wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = 'rooms'`).run(
    JSON.stringify(LONG),
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
    { id: 'butt-box', type: 'external', x: 0.68, y: 0.05, w: 0.28, h: 0.2, z: 101, config: { module: 'butt' } },
    { id: 'rooms-box', type: 'external', x: 0.68, y: 0.27, w: 0.28, h: 0.2, z: 102, config: { module: 'rooms' } },
    { id: 'trains-box', type: 'external', x: 0.05, y: 0.37, w: 0.6, h: 0.22, z: 103, config: { module: 'trains' } },
    { id: 'many-box', type: 'external', x: 0.68, y: 0.49, w: 0.28, h: 0.1, z: 104, config: { module: 'many' } },
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
        expect(rows.rows.map((row) => row.label)).toEqual(['Sprinkler', 'Shed door', 'Soil', 'Pond', 'Gate', 'Backup']);
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

  it(
    'fills a row’s bar to its progress at no cost in height, and winds a gauge to its number with capped words inside it',
    async () => {
      const opened = await loadWallSettled(link, PORTRAIT);
      try {
        const read = await opened.page.evaluate(() => {
          const garden = document.querySelector<HTMLElement>('#wall .canvas .fw[data-widget-id="garden-box"]');
          const butt = document.querySelector<HTMLElement>('#wall .canvas .fw[data-widget-id="butt-box"]');
          if (garden === null || butt === null) throw new Error('no module box');
          const colourOf = (inside: HTMLElement, value: string): string => {
            const probe = document.createElement('span');
            probe.style.color = value;
            inside.appendChild(probe);
            const out = getComputedStyle(probe).color;
            probe.remove();
            return out;
          };
          const bars = Array.from(garden.querySelectorAll<HTMLElement>('.gp-reading')).map((row) => {
            const track = row.querySelector<HTMLElement>('.gp-bar');
            const fill = row.querySelector<HTMLElement>('.gp-fill');
            const label = row.querySelector<HTMLElement>('.gp-label');
            const rowRect = row.getBoundingClientRect();
            const trackRect = track?.getBoundingClientRect();
            return {
              label: label?.textContent ?? '',
              height: rowRect.height,
              share:
                track === null || fill === null || trackRect === undefined
                  ? null
                  : fill.getBoundingClientRect().width / trackRect.width,
              fill: fill === null ? null : getComputedStyle(fill).backgroundColor,
              inside:
                trackRect === undefined ||
                (trackRect.bottom <= rowRect.bottom + 0.5 && trackRect.top >= rowRect.top - 0.5),
              width: trackRect?.width ?? 0,
              rowWidth: rowRect.width,
            };
          });
          const gaugeIn = (box: HTMLElement) => {
          const ring = box.querySelector<HTMLElement>('.gp-ring');
          const fill = box.querySelector<SVGCircleElement>('.gp-ring-fill');
          const value = box.querySelector<HTMLElement>('.gp-gauge-value');
          const label = box.querySelector<HTMLElement>('.gp-gauge-label');
          if (ring === null || fill === null || value === null || label === null) throw new Error('no gauge');
          const dash = (fill.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
          const r = Number(fill.getAttribute('r'));
          // The event role and the clock's cap, as this box resolves them.
          const role = document.createElement('span');
          role.style.fontSize = 'var(--t-wall-event, var(--t-event))';
          role.textContent = 'x';
          box.appendChild(role);
          const eventPx = parseFloat(getComputedStyle(role).fontSize);
          role.remove();
          const svg = ring.querySelector('svg');
          const svgRect = svg?.getBoundingClientRect();
          const square = svgRect === undefined ? 0 : Math.min(svgRect.width, svgRect.height);
          const valueRect = value.getBoundingClientRect();
          const cx = svgRect === undefined ? 0 : svgRect.left + svgRect.width / 2;
          const cy = svgRect === undefined ? 0 : svgRect.top + svgRect.height / 2;
          const corners = [
            [valueRect.left, valueRect.top], [valueRect.right, valueRect.top],
            [valueRect.left, valueRect.bottom], [valueRect.right, valueRect.bottom],
          ];
          const farthest = Math.max(...corners.map(([x, y]) => Math.hypot((x ?? 0) - cx, (y ?? 0) - cy)));
          const boxRect = box.getBoundingClientRect();
          return {
            wound: (dash[0] ?? 0) / (2 * Math.PI * r),
            ringStroke: getComputedStyle(fill).stroke,
            valuePx: parseFloat(getComputedStyle(value).fontSize),
            eventPx,
            // The ring's inner edge, in pixels: the radius less half the stroke, on a 100-unit square.
            innerRadius: (square / 100) * (r - 4.5),
            farthest,
            labelText: label.textContent,
            valueText: value.textContent,
            spilled: [ring, value, label].some((node) => {
              const rect = node.getBoundingClientRect();
              return rect.bottom > boxRect.bottom + 0.5 || rect.right > boxRect.right + 0.5;
            }),
          };
          };
          const rooms = document.querySelector<HTMLElement>('#wall .canvas .fw[data-widget-id="rooms-box"]');
          if (rooms === null) throw new Error('no rooms box');
          return {
            bars,
            accent: colourOf(garden, 'var(--accent)'),
            active: colourOf(garden, 'var(--state-active)'),
            idle: colourOf(butt, 'var(--state-idle)'),
            butt: gaugeIn(butt),
            rooms: gaugeIn(rooms),
          };
        });
        const byLabel = new Map(read.bars.map((bar) => [bar.label, bar]));
        // Filled to its number, measured off the drawn widths.
        expect(byLabel.get('Sprinkler')?.share).toBeCloseTo(0.45, 2);
        expect(byLabel.get('Backup')?.share).toBeCloseTo(1, 2);
        expect(byLabel.get('Gate')?.share).toBeNull();
        // In the row's tone, or the accent where it has none.
        expect(byLabel.get('Sprinkler')?.fill).toBe(read.active);
        expect(byLabel.get('Backup')?.fill).toBe(read.accent);
        expect(read.active).not.toBe(read.accent);
        // Inside its row, across it, and costing it no height.
        for (const bar of read.bars) expect(bar.inside).toBe(true);
        expect(byLabel.get('Backup')?.width).toBeCloseTo(byLabel.get('Backup')?.rowWidth ?? 0, 0);
        const heights = read.bars.map((bar) => Math.round(bar.height));
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

        // The gauge: wound to its number, in its tone, or the accent with none.
        expect(read.butt.wound).toBeCloseTo(0.72, 3);
        expect(read.rooms.wound).toBeCloseTo(0.375, 3);
        expect(read.butt.ringStroke).toBe(read.idle);
        expect(read.rooms.ringStroke).toBe(read.accent);
        expect(read.butt.valueText).toBe('72%');
        expect(read.butt.labelText).toBe('Full');
        // Its words never larger than a clock may be (D1), and inside the ring
        // — a short value and a long one alike.
        for (const gauge of [read.butt, read.rooms]) {
          expect(gauge.valuePx / gauge.eventPx).toBeLessThanOrEqual(1.8 + 1e-6);
          expect(gauge.farthest).toBeLessThan(gauge.innerRadius);
          expect(gauge.spilled).toBe(false);
        }
        // The long one is smaller for being long, rather than cut.
        expect(read.rooms.valueText).toBe('3 of 8 rooms done');
        expect(read.rooms.valuePx).toBeLessThan(read.butt.valuePx);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'puts a row’s line in one slot on every row, lines a table’s cells up, and gives up whole table rows',
    async () => {
      const opened = await loadWallSettled(link, PORTRAIT);
      try {
        const read = await opened.page.evaluate(() => {
          const box = (id: string): HTMLElement => {
            const found = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
            if (found === null) throw new Error(`no box ${id}`);
            return found;
          };
          const garden = box('garden-box');
          const rows = Array.from(garden.querySelectorAll<HTMLElement>('.gp-reading')).map((row) => {
            const spark = row.querySelector<HTMLElement>('.gp-spark');
            const value = row.querySelector<HTMLElement>('.gp-value');
            const rect = spark?.getBoundingClientRect();
            return {
              label: row.querySelector('.gp-label')?.textContent ?? '',
              slot: rect === undefined ? null : { left: rect.left, width: rect.width },
              line: spark?.querySelector('polyline') !== null && spark?.querySelector('polyline') !== undefined,
              lines: spark?.querySelectorAll('polyline').length ?? 0,
              valueRight: value?.getBoundingClientRect().right ?? 0,
            };
          });
          const tableIn = (id: string) => {
            const host = box(id);
            const hostRect = host.getBoundingClientRect();
            const lines = Array.from(host.querySelectorAll<HTMLElement>('.gp-thead, .gp-trow'));
            return {
              cells: lines
                .filter((line) => getComputedStyle(line).display !== 'none')
                .map((line) =>
                  Array.from(line.querySelectorAll<HTMLElement>('.gp-cell')).map((cell) => {
                    const r = cell.getBoundingClientRect();
                    return {
                      text: cell.textContent ?? '',
                      left: r.left,
                      right: r.right,
                      width: r.width,
                      height: r.height,
                      cut: cell.scrollWidth > cell.clientWidth + 1,
                    };
                  }),
                ),
              hidden: lines.filter((line) => getComputedStyle(line).display === 'none').length,
              overflow: lines
                .filter((line) => getComputedStyle(line).display !== 'none')
                .some((line) => line.getBoundingClientRect().bottom > hostRect.bottom + 0.5),
              total: lines.length,
            };
          };
          return { rows, trains: tableIn('trains-box'), many: tableIn('many-box') };
        });

        // One slot of one width on every row, once any row has a line.
        expect(read.rows.every((row) => row.slot !== null)).toBe(true);
        const lefts = read.rows.map((row) => Math.round(row.slot?.left ?? 0));
        const widths = read.rows.map((row) => Math.round(row.slot?.width ?? 0));
        expect(new Set(lefts).size).toBe(1);
        expect(new Set(widths).size).toBe(1);
        expect(widths[0]).toBeGreaterThan(0);
        // Values end at one edge.
        expect(Math.max(...read.rows.map((r) => r.valueRight)) - Math.min(...read.rows.map((r) => r.valueRight))).toBeLessThan(1);
        // The soil's line, broken at its gap into two runs, and no line where none was sent.
        const soil = read.rows.find((row) => row.label === 'Soil');
        expect(soil?.lines).toBe(2);
        expect(read.rows.find((row) => row.label === 'Gate')?.lines).toBe(0);

        // The table: a heading and three rows, every cell of a column at one edge.
        expect(read.trains.cells.map((line) => line.map((cell) => cell.text))).toEqual([
          ['To', 'Due', 'Platform'],
          ['London Bridge via Redhill and Croydon', '08:12', '2'],
          ['Brighton', '08:20', '1'],
          ['Lewes', '08:31', '4'],
        ]);
        for (let column = 0; column < 3; column++) {
          const lefts = read.trains.cells.map((line) => Math.round(line[column]?.left ?? 0));
          const rights = read.trains.cells.map((line) => Math.round(line[column]?.right ?? 0));
          expect(new Set(lefts).size).toBe(1);
          expect(new Set(rights).size).toBe(1);
        }
        // The first column twice each of the others.
        const [first, second, third] = read.trains.cells[1] ?? [];
        expect((first?.width ?? 0) / (second?.width ?? 1)).toBeCloseTo(2, 0);
        expect(second?.width).toBeCloseTo(third?.width ?? 0, 0);
        // The long cell wrapped whole rather than being cut.
        const long = read.trains.cells[1]?.[0];
        expect(long?.cut).toBe(false);
        expect(long?.height ?? 0).toBeGreaterThan((read.trains.cells[2]?.[0]?.height ?? 0) * 1.5);

        // A box too short for twelve rows gives up whole rows: some hidden, and
        // none of those it draws past its foot.
        expect(read.many.hidden).toBeGreaterThan(0);
        expect(read.many.cells.length).toBeGreaterThan(1);
        expect(read.many.overflow).toBe(false);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
