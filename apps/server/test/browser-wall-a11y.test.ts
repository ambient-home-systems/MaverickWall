import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  equipHousehold,
  HOUSEHOLD_CALENDARS,
  install,
  settleWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

/**
 * Three things a household has to be able to read or hear, measured on the
 * wall rather than read out of the stylesheet.
 *
 * All three come from one audit finding with one shape: **a decision taken at
 * the call site, outside the system built to govern it.** `--ink-scaffold` is
 * derived per theme by raising its mix ratio until it clears 4.5:1, and a
 * literal `opacity: 0.42` on the cell multiplied straight through it. The
 * takeover's issuing office was demoted twice, to a token whose documented job
 * is to be unreadable. And an interrupt — the only safety content this product
 * draws — reached the accessibility tree as nothing at all.
 */

process.env['TZ'] = 'UTC';
const SLOW = 240_000;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  /*
   * The household's own calendars, plus one event that has already happened.
   *
   * `HOUSEHOLD_CALENDARS` starts at `day: 0` and the manifest window opens at
   * `today - 1`, so on that fixture alone every past cell in the grid is
   * *empty* — the first draft of the second test below failed on its own
   * premise, having measured nothing at all. A past day with nothing on it
   * cannot show whether a past day's words are readable.
   */
  wall = await install({
    calendars: [
      ...HOUSEHOLD_CALENDARS,
      { name: 'Yesterday', events: [{ title: 'Recycling collected', day: -1 }] },
    ],
  });
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
  // A 32" panel hung portrait, read from 1.2 m — a preset from the product's
  // own catalogue, so the type scale is the one a household actually gets.
  wall.db
    .prepare(
      `UPDATE screens SET panel_width_mm = 708, panel_height_mm = 398, read_distance_mm = 1200
        WHERE id = ?`,
    )
    .run(screenId);
}, SLOW);

afterAll(async () => {
  await shutDownBrowser();
  await wall?.dispose();
}, TEARDOWN);

function setTheme(name: string): void {
  wall.db
    .prepare(`UPDATE household_settings SET theme = ?, updated_at = ? WHERE id = 'singleton'`)
    .run(name, wall.now());
}

/** WCAG contrast between two `rgb(...)` strings, as the browser reports them. */
function ratioOf(a: string, b: string): number {
  const channels = (value: string): [number, number, number] => {
    const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    return parts === null ? [0, 0, 0] : [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  };
  const luminance = (value: string): number =>
    channels(value)
      .map((raw) => {
        const c = raw / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i]! * c, 0);
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

async function open(size = { width: 1080, height: 1920 }): Promise<{
  page: Page;
  close: () => Promise<void>;
}> {
  const context = await (await browser()).newContext({ viewport: size });
  const page = await context.newPage();
  await page.goto(link, { waitUntil: 'load' });
  await settleWall(page);
  return { page, close: (): Promise<void> => context.close() };
}

/**
 * A run of text with the ground actually behind it and the opacity actually
 * applied to it — the two things a declaration cannot tell you.
 */
const SWEEP = `
(() => {
  const rgb = (s) => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(s);
    if (m === null) return null; if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return { r: +m[1], g: +m[2], b: +m[3] }; };
  const over = (f, b, a) => ({ r: f.r*a + b.r*(1-a), g: f.g*a + b.g*(1-a), b: f.b*a + b.b*(1-a) });
  const out = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if ((el.textContent || '').trim() === '') continue;
    let alpha = 1, ground = null;
    for (let p = el; p !== null; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      alpha *= parseFloat(pcs.opacity || '1');
      if (ground === null) ground = rgb(pcs.backgroundColor);
    }
    if (ground === null) ground = { r: 255, g: 255, b: 255 };
    const fg = rgb(cs.color) || { r: 0, g: 0, b: 0 };
    const eff = over(fg, ground, alpha);
    out.push({ text: (el.textContent || '').trim().slice(0, 30), cls: String(el.className || ''),
      alpha: Math.round(alpha * 100) / 100,
      color: 'rgb(' + [eff.r, eff.g, eff.b].map(Math.round).join(', ') + ')',
      ground: 'rgb(' + [ground.r, ground.g, ground.b].map(Math.round).join(', ') + ')' });
  }
  return out;
})()`;

interface Run {
  readonly text: string;
  readonly cls: string;
  readonly alpha: number;
  readonly color: string;
  readonly ground: string;
}

const sweep = async (page: Page, selector: string): Promise<Run[]> =>
  (await page.evaluate(SWEEP.replace('SELECTOR', JSON.stringify(selector)))) as Run[];

describe('a day that has already happened', () => {
  it('is demoted in tokens and never faded, on every theme', async () => {
    /*
     * `.hz-cell.dim` was `opacity: 0.42`, which is not a colour: it composites
     * every child against the page and takes the tuned scaffold ink with it.
     * Measured before the fix, a past day's numeral read 2.13:1 on Panels,
     * 1.65:1 on Household and 1.64:1 on Almanac — the theme scheduled for
     * daylight — and a past day that also belonged to the next month reached
     * 1.44:1, having taken `--faint` and the fade together.
     *
     * The assertion is on the *composited* opacity rather than on the rule,
     * because that is the thing a household sees and the thing a later edit
     * could quietly reintroduce one selector along at a gentler number.
     */
    for (const theme of ['panels', 'household', 'blueprint', 'almanac', 'swiss']) {
      setTheme(theme);
      const { page, close } = await open();
      try {
        const cells = await sweep(page, '.hz-cell.dim, .sk-cell.dim, .wc-col.dim, .sk-col.dim');
        expect(cells.length, `${theme}: no past day was drawn, so this measured nothing`)
          .toBeGreaterThan(0);
        const faded = cells.filter((run) => run.alpha < 1);
        expect(
          faded.map((run) => `${run.cls} at ${run.alpha}`),
          `${theme}: a past day is faded rather than demoted`,
        ).toEqual([]);
      } finally {
        await close();
      }
    }
  }, SLOW);

  it('says what is on it in the quiet role, and more clearly than the fade did', async () => {
    /*
     * The point of removing the fade — and the claim is deliberately not "4.5:1
     * absolutely", because on a light theme's *tinted* ground no token in this
     * bundle reaches it. That is a real, separate, recorded fault: a rota wash
     * moves the ground toward the ink by construction and costs roughly 0.6 of
     * a point, which `theme.test.ts`'s allow-list now measures since `GROUNDS`
     * learned about the tints. Asserting a floor here would be this test
     * failing on somebody else's unfixed problem while saying nothing about
     * this one.
     *
     * What the fix does claim, and what is asserted:
     *
     *  - the words are drawn in `--ink-quiet`, so they are inside the system
     *    that governs contrast rather than beside it; and
     *  - they are strictly more readable than the fade they replace, measured
     *    against the identical ground.
     *
     * The second is computed rather than remembered: the old treatment is
     * `--ink-event` composited at 0.42 over whatever is behind this very cell,
     * so the comparison holds on a rota-tinted day and a plain one alike, and
     * reinstating the fade makes the two equal rather than better.
     */
    for (const theme of ['panels', 'household', 'blueprint', 'almanac', 'swiss']) {
      setTheme(theme);
      const { page, close } = await open();
      try {
        const names = await sweep(page, '.hz-cell.dim .hz-rowtext');
        expect(names.length, `${theme}: no past day drew an event name`).toBeGreaterThan(0);

        const tokens = (await page.evaluate(`
          (() => { const r = getComputedStyle(document.documentElement);
            const rgbOf = (hex) => { const n = parseInt(hex.trim().replace('#',''), 16);
              return 'rgb(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ') + ')'; };
            return { quiet: rgbOf(r.getPropertyValue('--ink-quiet')),
                     faint: rgbOf(r.getPropertyValue('--faint')),
                     event: rgbOf(r.getPropertyValue('--ink-event')) }; })()`)) as {
          quiet: string;
          faint: string;
          event: string;
        };
        // The premise: on a theme drawing these the same, neither claim can fail.
        expect(tokens.quiet, `${theme} draws --ink-quiet as --faint`).not.toBe(tokens.faint);

        for (const run of names) {
          expect(run.color, `${theme}: "${run.text}" is not drawn in --ink-quiet`).toBe(tokens.quiet);

          const faded = tokens.event
            .replace(/[^\d,]/g, '')
            .split(',')
            .map(Number)
            .map((channel, i) => {
              const behind = run.ground.replace(/[^\d,]/g, '').split(',').map(Number)[i]!;
              return Math.round(channel * 0.42 + behind * 0.58);
            });
          const before = ratioOf(`rgb(${faded.join(', ')})`, run.ground);
          const after = ratioOf(run.color, run.ground);
          expect(
            after,
            `${theme}: "${run.text}" reads ${after.toFixed(2)}:1 where the fade read ` +
              `${before.toFixed(2)}:1 — no better`,
          ).toBeGreaterThan(before);
        }
      } finally {
        await close();
      }
    }
  }, SLOW);
});

describe('the takeover, on the theme scheduled for daylight', () => {
  const at = (): number => wall.now();

  function seed(action: string, dismissible: number): void {
    wall.db.prepare(`DELETE FROM active_alerts`).run();
    wall.db.prepare(`DELETE FROM interrupt_rules`).run();
    wall.db
      .prepare(
        `INSERT INTO active_alerts (id, external_id, sent, message_type, zone_code, event, headline,
          description, instruction, area_desc, sender_name, severity, urgency, certainty,
          onset_at, expires_at, fetched_at)
         VALUES ('a1','a1',?,'Alert','LDZ001','Tornado Warning',?,?,?,?,?,'Extreme','Immediate','Observed',?,?,?)`,
      )
      .run(
        new Date(at()).toISOString(),
        'Tornado Warning for Greater London',
        'A line of severe storms is moving through the area.',
        'Move to an interior room on the lowest floor of a sturdy building.',
        'Greater London',
        'NWS London',
        at(),
        at() + 3_600_000,
        at(),
      );
    wall.db
      .prepare(
        `INSERT INTO interrupt_rules (id,name,enabled,trigger,conditions,action,priority,wake_screen,
          dismiss_after_seconds,pierces_night_mode,min_dwell_sec,dismissible,reassert_after_sec,created_at,updated_at)
         VALUES ('r','r',1,'nws',?,?,0,0,NULL,0,0,?,NULL,?,?)`,
      )
      .run(JSON.stringify({ minSeverity: 'Severe' }), action, dismissible, at(), at());
  }

  afterAll(() => {
    wall.db.prepare(`DELETE FROM interrupt_rules`).run();
    wall.db.prepare(`DELETE FROM active_alerts`).run();
    setTheme('panels');
  });

  it('names its issuing office at a ratio somebody can read', async () => {
    /*
     * Measured before the fix: `.alert-office` was `--faint` and read **2.48:1
     * at 32.6px on Almanac** — the theme a household is looking at in the
     * middle of the day, on the screen that has replaced their calendar with a
     * tornado warning. "Who says so" is the difference between acting on it
     * and ignoring it.
     *
     * The whole foot moved to `--ink-scaffold` rather than the office alone:
     * leaving the office quieter than the clock beside it is a nicety, and it
     * is not worth a line nobody can read on this screen.
     */
    seed('takeover', 0);
    for (const theme of ['almanac', 'panels', 'household', 'blueprint', 'swiss']) {
      setTheme(theme);
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      const page = await context.newPage();
      try {
        await page.goto(link, { waitUntil: 'load' });
        // Not `settleWall`: a takeover replaces the canvas, so `#wall .canvas`
        // never appears and waiting for it is waiting for the thing this test
        // is asserting is gone.
        await page.waitForSelector('.screen-alert', { timeout: 20_000 });
        await page.evaluate('document.fonts.ready.then(() => undefined)');

        const foot = await sweep(page, '.alert-foot > *');
        expect(foot.length, `${theme}: the takeover drew no foot`).toBeGreaterThan(0);
        const unreadable = foot
          .map((run) => ({ ...run, ratio: Number(ratioOf(run.color, run.ground).toFixed(2)) }))
          .filter((run) => run.ratio < 4.5);
        expect(
          unreadable,
          `${theme}: ` + unreadable.map((r) => `.${r.cls} "${r.text}" ${r.ratio}:1`).join(', '),
        ).toEqual([]);
        // The premise: the office really is one of the things being measured.
        expect(foot.map((run) => run.cls)).toContain('alert-office');
      } finally {
        await context.close();
      }
    }
  }, SLOW);
});

describe('what the wall speaks', () => {
  const at = (): number => wall.now();

  afterAll(() => {
    wall.db.prepare(`DELETE FROM interrupt_rules`).run();
    wall.db.prepare(`DELETE FROM active_alerts`).run();
  });

  it('announces an interrupt once, and does not repeat it every fifteen seconds', async () => {
    /*
     * **The reason this is not a `role="alert"` in `render.ts`.**
     *
     * Every renderer here begins `root.textContent = ''`, and the wall redraws
     * on a fifteen-second tick, for months. A live region built by
     * `renderAlert` would be a *new node* on every one of those, and a live
     * region that is recreated announces again — so the obvious fix reads a
     * household their tornado warning four times a minute until they unplug
     * the screen. The region lives on `<body>`, outside the subtree that is
     * cleared, and its text is set only when the sentence changes.
     *
     * Measured over two ticks rather than asserted from the source, because
     * "it is outside `#wall`" is a claim about placement and this is a claim
     * about what a synthesiser would say.
     */
    setTheme('panels');
    wall.db.prepare(`DELETE FROM active_alerts`).run();
    wall.db.prepare(`DELETE FROM interrupt_rules`).run();
    wall.db
      .prepare(
        `INSERT INTO active_alerts (id, external_id, sent, message_type, zone_code, event, headline,
          description, instruction, area_desc, sender_name, severity, urgency, certainty,
          onset_at, expires_at, fetched_at)
         VALUES ('a2','a2',?,'Alert','LDZ001','Flood Advisory',?,?,?,?,?,'Moderate','Expected','Likely',?,?,?)`,
      )
      .run(
        new Date(at()).toISOString(),
        'Flood Advisory for Greater London',
        'Standing water is likely on low roads.',
        'Avoid low ground and do not drive through floodwater.',
        'Greater London',
        'NWS London',
        at(),
        at() + 3_600_000,
        at(),
      );
    wall.db
      .prepare(
        `INSERT INTO interrupt_rules (id,name,enabled,trigger,conditions,action,priority,wake_screen,
          dismiss_after_seconds,pierces_night_mode,min_dwell_sec,dismissible,reassert_after_sec,created_at,updated_at)
         VALUES ('r2','r2',1,'nws',?,'banner',0,0,NULL,0,0,1,NULL,?,?)`,
      )
      .run(JSON.stringify({ minSeverity: 'Minor' }), at(), at());

    const { page, close } = await open();
    try {
      const region = await page.evaluate(`
        (() => {
          const node = document.querySelector('[role="alert"], [aria-live]');
          if (node === null) return { found: false };
          const cs = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return { found: true, role: node.getAttribute('role'),
            text: (node.textContent || '').trim(),
            insideWall: document.getElementById('wall').contains(node),
            display: cs.display, visibility: cs.visibility,
            width: Math.round(box.width), height: Math.round(box.height) };
        })()`);
      const seen = region as {
        found: boolean;
        role?: string;
        text?: string;
        insideWall?: boolean;
        display?: string;
        visibility?: string;
        width?: number;
        height?: number;
      };

      expect(seen.found, 'the wall announced nothing at all').toBe(true);
      expect(seen.role).toBe('alert');
      expect(seen.text).toContain('Flood Advisory');
      expect(seen.text).toContain('Avoid low ground');
      /*
       * Outside `#wall` is not a tidiness preference — it is the only thing
       * that stops the fifteen-second tick from recreating the node.
       */
      expect(seen.insideWall, 'the region is inside the subtree every draw clears').toBe(false);
      /*
       * Hidden the way a live region must be. `display: none` and
       * `visibility: hidden` take it out of the accessibility tree and so out
       * of its only job; a 1px clipped box is the recipe that leaves it there.
       */
      expect(seen.display).not.toBe('none');
      expect(seen.visibility).not.toBe('hidden');
      expect(seen.width).toBeLessThanOrEqual(1);
      expect(seen.height).toBeLessThanOrEqual(1);

      /*
       * And it stays the same node with the same words across a redraw. A new
       * node, or the same node re-assigned, is a second announcement.
       */
      await page.evaluate(`
        (() => {
          const node = document.querySelector('[role="alert"]');
          node.setAttribute('data-witness', '1');
          window.__writes = 0;
          const proto = Object.getPrototypeOf(node);
          const own = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
          Object.defineProperty(node, 'textContent', {
            get() { return own.get.call(this); },
            set(v) { window.__writes++; own.set.call(this, v); },
          });
          void proto;
        })()`);
      // Two ticks of the fifteen-second redraw, plus a margin.
      await page.waitForTimeout(32_000);
      const after = (await page.evaluate(`
        (() => {
          const node = document.querySelector('[role="alert"]');
          return { sameNode: node !== null && node.getAttribute('data-witness') === '1',
            writes: window.__writes, text: (node ? node.textContent : '').trim() };
        })()`)) as { sameNode: boolean; writes: number; text: string };

      expect(after.sameNode, 'the live region was rebuilt, so it announced again').toBe(true);
      expect(
        after.writes,
        `the region's text was written ${after.writes} time(s) across two redraws`,
      ).toBe(0);
      expect(after.text).toContain('Flood Advisory');
    } finally {
      await close();
    }
  }, SLOW);

  it('says nothing at all when nothing is interrupting', async () => {
    // The other half: a region that always holds a sentence is a region that
    // announces the calendar.
    wall.db.prepare(`DELETE FROM interrupt_rules`).run();
    wall.db.prepare(`DELETE FROM active_alerts`).run();
    const { page, close } = await open();
    try {
      const text = await page.evaluate(`
        (() => { const n = document.querySelector('[role="alert"], [aria-live]');
          return n === null ? null : (n.textContent || '').trim(); })()`);
      expect(text === null || text === '').toBe(true);
    } finally {
      await close();
    }
  }, SLOW);
});
