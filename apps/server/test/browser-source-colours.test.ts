import { afterAll, describe, expect, it } from 'vitest';
import { TEARDOWN, browser, install, settleWall, shutDownBrowser, type NamedFeed } from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

/**
 * Three calendars, three colours, measured on a real wall.
 *
 * `palette.test.ts` proves the rotation writes distinct hexes into SQLite. This
 * asks the only question that actually matters: does a household looking at the
 * wall see three different things? Every colour below is read back as a
 * **computed** background or border, never as a class or a custom property —
 * this project has shipped a bug where the class was applied and the pixels
 * were wrong (the chore tick's empty box), and `--pc` on an element proves the
 * renderer set a variable, not that anything was painted with it.
 *
 * The calendars are added through the real `POST /admin/calendars` form, which
 * is what the report did ("added three calendars through the UI"), and synced
 * through the real job. Nothing here inserts a row or a colour by hand.
 *
 * **Where the colour lives moved, and these two tests moved with it.** The
 * month grid's default cell treatment is flat names now rather than pills, so
 * on the wall a household actually gets, a timed event carries its calendar's
 * colour in its dot and an all-day one in the rule down its row. The first test
 * reads whichever of those the default draws — the claim is "three colours are
 * visibly on the glass", not "three pills are". The second test is about a
 * *clipped* title, which the default treatment no longer produces at all, so it
 * asks its question where the answer still matters: a canvas that chose
 * `cellEvents: 'pills'`, which is the one place a month cell still cuts a name
 * and the colour is the only thing left saying whose it is.
 */

afterAll(async () => {
  await shutDownBrowser();
}, TEARDOWN);

/** `rgb(76, 127, 209)` → `#4C7FD1`, so a failure names a colour a person knows. */
function toHex(computed: string): string {
  const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  if (parts === null) return computed;
  return `#${[1, 2, 3]
    .map((i) => Number(parts[i]).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** Three calendars a household would actually have: three different lives. */
const FEEDS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: 2 },
      { title: 'Bin day', day: 9 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Book club', day: 5, from: '1930', to: '2130' },
      { title: 'Car service', day: 11, from: '0800', to: '1200' },
      { title: 'Swimming lesson', day: 4, from: '0730', to: '0830' },
    ],
  },
  {
    name: 'School',
    events: [
      { title: 'INSET day - school closed', day: 7 },
      { title: 'School trip to the aquarium', day: 3, from: '0830', to: '1600' },
      { title: 'Parents evening', day: 2, from: '1800', to: '2000' },
      { title: 'Football practice', day: 6, from: '1730', to: '1900' },
      { title: 'Term ends', day: 12 },
    ],
  },
  {
    name: 'Work',
    events: [
      { title: 'Standup', day: 1, from: '0930', to: '0945' },
      { title: 'Standup', day: 8, from: '0930', to: '0945' },
      { title: 'On call', day: 10 },
      { title: 'One to one', day: 5, from: '1130', to: '1200' },
      { title: 'Sprint retro', day: 13, from: '1600', to: '1700' },
    ],
  },
];

/**
 * One thing on the glass painted in a calendar's colour.
 *
 * Deliberately not "a pill": the default grid paints a dot, an all-day row
 * paints its left rule, and a pills canvas paints a ground or a left border.
 * They are one question — is this calendar's colour visible here — so they are
 * one shape, and the test says which of them it went looking for.
 */
interface Mark {
  readonly background: string;
  readonly border: string;
  readonly truncated: boolean;
  readonly text: string;
}

/** The colour a mark actually shows: its ground, or its rule when it has none. */
const colourOf = (mark: Mark): string =>
  toHex(mark.background === 'rgba(0, 0, 0, 0)' ? mark.border : mark.background);

async function threeCalendarWall(cellEvents?: 'pills'): Promise<{
  stored: { name: string; color: string }[];
  marks: Mark[];
  dispose: () => Promise<void>;
}> {
  /*
   * Three calendars with three calendars' worth of events, each added through
   * the real `POST /admin/calendars` form and synced by the real job.
   *
   * They used to be three names against *one* feed — the addresses were not
   * what was under test, so one URL did. That stopped working the day the month
   * grid started drawing a title whole or not at all: three sources carrying
   * byte-identical events give every cell three identical rows, the cell has
   * room for one, and the same source wins every time. Measured, exactly one of
   * the three colours reached the glass — a true reading of a fixture no
   * household has. Distinct events per calendar is both the realistic case and
   * the one where the question ("do I see three different things?") means
   * anything.
   */
  const home = await install({ calendars: FEEDS });

  const stored = home.db
    .prepare('SELECT name, color FROM calendar_sources ORDER BY created_at, rowid')
    .all() as { name: string; color: string }[];

  const link = await home.pairLink();
  if (cellEvents !== undefined) {
    /*
     * A canvas that asked for pills. The screen is seeded with its own copy of
     * Classic when it is created, so this replaces that rather than the
     * household's — writing the household's would be overridden by the wall's
     * own and the page would quietly draw the default instead.
     */
    const screen = (home.db.prepare('SELECT id FROM screens').get() as { id: string }).id;
    replaceLayout(home.db, screen, 'portrait', {
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [
        {
          id: 'cal-portrait',
          type: 'calendar',
          x: 0.02,
          y: 0.02,
          w: 0.96,
          h: 0.96,
          z: 0,
          config: { mode: 'month', cellEvents },
        },
      ],
      background: null,
    });
  }

  const page = await (await browser()).newPage();
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.goto(link, { waitUntil: 'load' });
  await settleWall(page);

  const marks = await page.evaluate((pills: boolean) => {
    const out: {
      background: string;
      border: string;
      truncated: boolean;
      text: string;
    }[] = [];
    /*
     * Where the colour is painted, per treatment. On a pills canvas it is the
     * pill's own ground (or its left border, for an all-day one). On the
     * default flat grid it is the dot ahead of a timed event, and the rule down
     * the left of an all-day row — which has no dot precisely because the words
     * get that column instead.
     */
    const selector = pills ? '.hz-pill' : '.hz-rowdot, .hz-row.allday';
    document.querySelectorAll(selector).forEach((node) => {
      const el = node as HTMLElement;
      if (el.classList.contains('hz-pill-more')) return;
      // A row hidden by the trim is not on the glass, and a colour nobody can
      // see does not count towards "three colours are visible".
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return;
      const style = getComputedStyle(el);
      // The words belonging to this mark: a pill carries its own, a dot's are
      // in the row beside it, and an all-day row's are inside it.
      const words = el.classList.contains('hz-rowdot')
        ? (el.parentElement?.textContent ?? '')
        : (el.textContent ?? '');
      // The stakes, measured rather than assumed: a title that does not fit
      // inside the box drawn for it.
      const box = el.classList.contains('hz-pill')
        ? el
        : ((el.classList.contains('hz-rowdot') ? el.parentElement : el)?.querySelector(
            '.hz-rowtext',
          ) as HTMLElement | null);
      out.push({
        background: style.backgroundColor,
        border: style.borderLeftColor,
        truncated: box !== null && box.scrollWidth > box.clientWidth + 1,
        text: words,
      });
    });
    return out;
  }, cellEvents === 'pills');

  return {
    stored,
    marks,
    dispose: async (): Promise<void> => {
      await page.close();
      await home.dispose();
    },
  };
}

describe('three calendars on a real wall', () => {
  it('draws them in three different colours, and one of them is not blue', async () => {
    const wall = await threeCalendarWall();
    try {
      expect(wall.stored.map((row) => row.name)).toEqual(['Family', 'School', 'Work']);
      expect(new Set(wall.stored.map((row) => row.color.toUpperCase())).size).toBe(3);

      expect(wall.marks.length).toBeGreaterThan(0);

      // A dot paints its background; an all-day row paints its left rule
      // instead and leaves the background transparent. Either way the
      // calendar's colour is the one visibly on the glass.
      const drawn = new Set(wall.marks.map(colourOf));
      expect([...drawn].sort()).toEqual(
        [...wall.stored.map((row) => row.color.toUpperCase())].sort(),
      );
    } finally {
      await wall.dispose();
    }
  }, 120_000);

  it('keeps a truncated pill telling you whose it is', async () => {
    /*
     * Why this matters more than it looks: a pill cuts its title off, so one
     * reading "School trip to the aq…" carries no information at all unless its
     * colour differs from the one under it.
     *
     * Asked of a **pills canvas** rather than of the default wall, and that is
     * the point rather than a workaround. The default treatment draws a title
     * whole or not at all, so there is no clipped name on it to rescue — but
     * `pills` is still a treatment a household can choose and canvases still
     * store it, and there the colour is the only thing left. A test that went
     * looking for a clipped title on the default wall would find none and pass
     * while proving nothing.
     */
    const wall = await threeCalendarWall('pills');
    try {
      const clipped = wall.marks.filter((mark) => mark.truncated);
      expect(clipped.length, 'no pill was clipped, so this proves nothing').toBeGreaterThan(0);
      expect(new Set(clipped.map(colourOf)).size).toBeGreaterThan(1);
    } finally {
      await wall.dispose();
    }
  }, 120_000);

  it('draws no clipped name at all on the wall a household gets', async () => {
    /*
     * The other side of the test above, and the reason it had to move. On the
     * default treatment a month cell shows a title whole or shows none of it,
     * so "the colour is all you have left" is a state this wall cannot reach.
     */
    const wall = await threeCalendarWall();
    try {
      const clipped = wall.marks.filter((mark) => mark.truncated);
      expect(
        clipped.map((mark) => mark.text.trim()),
        'a name was cut off on the default month grid',
      ).toEqual([]);
    } finally {
      await wall.dispose();
    }
  }, 120_000);
});
