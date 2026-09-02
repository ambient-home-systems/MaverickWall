/**
 * A running event must not cost the agenda a row.
 *
 * The wall draws a progress bar on an event that is happening now. It was an
 * in-flow grid item, so it cost the entry its own row track *and* one more
 * `row-gap` — measured on the shipped Classic wall, a running entry stood
 * 53.8px against 40.1px for every other one. `fitToBox` scaled the whole
 * agenda to its box, so that came off the scale: 0.983, or 1.7% smaller type
 * on every run in the section. `.dr-shift` — the rota chip, the one run in the
 * agenda that carries a colour — is `var(--t-micro)`, 22.08px, which has 0.36%
 * of headroom over this product's 22px floor. So one running event put it at
 * **21.7px** and under the floor, for exactly as long as that event ran.
 *
 * That is `.dr-now`'s lesson one element along, and CLAUDE.md already records
 * it in those words: a hairline that costs a word is not a hairline.
 *
 * This file is deliberately the *whole* mechanism rather than the symptom.
 * `browser-classic-proportions` measures the same floor and cannot see this,
 * because since `HARNESS_HOUR` the harness draws every wall at a quiet hour —
 * which is right, and is what makes a density baseline a baseline, but it
 * means nothing in the suite draws a running event unless it says so. This one
 * says so: its fixture is built *from* `HARNESS_HOUR`, so it stays live if that
 * hour ever moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HARNESS_HOUR,
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type FeedEvent,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and a wall. */
const SLOW = 180_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

const clock = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;

/**
 * The shipped fixture, with one event still running at the hour the wall is
 * drawn — and **nothing else changed**.
 *
 * That "nothing else" is the whole design of this file. A first draft added a
 * fourth calendar carrying the live event, which put the rota chip at 20.2px
 * with the fix applied: an agenda holding one more event is a smaller agenda
 * whatever the bar does, so the measurement was answering a different question
 * from the one it asked. Here the *same* events are drawn either way — only the
 * chosen one's end time moves, and the time column renders `startsAt` alone
 * (`eventTime`), so not one glyph on the wall differs between the two walls.
 * The only variable left is whether an event is running.
 *
 * Which event is chosen is computed rather than named, so a later edit to
 * `HOUSEHOLD_CALENDARS` cannot silently leave this measuring an ordinary wall:
 * the latest `day: 0` event that starts before the drawn hour, extended past
 * it. `running.length` is asserted below, which is what makes the choice safe.
 */
function withOneRunning(calendars: readonly NamedFeed[]): readonly NamedFeed[] {
  const startsBeforeTheHour = (event: FeedEvent): boolean =>
    event.day === 0 && event.from !== undefined && Number(event.from) < HARNESS_HOUR * 100;
  const latest = calendars
    .flatMap((calendar) => calendar.events)
    .filter(startsBeforeTheHour)
    .sort((a, b) => Number(a.from) - Number(b.from))
    .at(-1);
  if (latest === undefined) throw new Error('no day-0 event starts before the drawn hour');
  return calendars.map((calendar) => ({
    ...calendar,
    events: calendar.events.map((event) =>
      event === latest ? { ...event, to: clock(HARNESS_HOUR, 30) } : event,
    ),
  }));
}

/**
 * An event that started yesterday evening and is still running now.
 *
 * The only fixture in the suite that gives a *timed* entry a second grid row:
 * `spanLabel` draws "Day 2 of 2" when an event covers more than one date, and a
 * running event with a span is the one case where "under the time" and "at the
 * bottom of the entry" are different places. Without it the bar's `grid-row`
 * is an edit no assertion here can contradict — checked, found green with the
 * row dropped, and this is what made it go red.
 */
const OVERNIGHT: readonly NamedFeed[] = [
  {
    name: 'Nights',
    events: [
      { title: 'Night shift', day: -1, from: '2200', to: clock(HARNESS_HOUR, 30), toDay: 0 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
    ],
  },
];

let quiet: Installation;
let live: Installation;
let overnight: Installation;
let quietLink: string;
let liveLink: string;
let overnightLink: string;

beforeAll(async () => {
  // The rota is not decoration on either wall: `.dr-shift` is the run this bug
  // lands on, and a household with no rota does not draw one at all.
  quiet = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(quiet.db, quiet.now());
  quietLink = await quiet.pairLink('Kitchen');

  live = await install({ calendars: withOneRunning(HOUSEHOLD_CALENDARS) });
  equipHousehold(live.db, live.now());
  liveLink = await live.pairLink('Kitchen');

  overnight = await install({ calendars: OVERNIGHT });
  equipHousehold(overnight.db, overnight.now());
  overnightLink = await overnight.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await quiet?.dispose();
  await live?.dispose();
  await overnight?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Run {
  readonly where: string;
  readonly text: string;
  readonly font: number;
}

interface Agenda {
  /**
   * Every text run the agenda's own rows draw, at the size it reaches the
   * glass.
   *
   * Scoped to `.day-row` rather than to the whole `.next` section, which is
   * what `browser-classic-proportions` means by "the agenda" too: the widget's
   * own title bar is a different thing with a different argument about it, and
   * measuring it here would make this file fail for a reason it is not about.
   */
  readonly runs: readonly Run[];
  /** Whether the entry carrying the bar also drew a "Day 2 of 2" row. */
  readonly spanned: boolean;
  /** Entry heights, split by whether the entry carries a progress bar. */
  readonly running: readonly number[];
  readonly ordinary: readonly number[];
  /** The bar itself: is it drawn, where, and how far along. */
  readonly bar:
    | {
        readonly position: string;
        readonly height: number;
        readonly width: number;
        readonly fill: number;
        readonly insideEntry: boolean;
        readonly clearOfTimeText: number;
        /** Clear of the span line below, when there is one. */
        readonly aboveSpanText: boolean;
        /** Inside the time's own column, rather than spanning the entry. */
        readonly withinTimeColumn: boolean;
      }
    | undefined;
}

async function measureAgenda(
  link: string,
  size: { readonly width: number; readonly height: number },
): Promise<Agenda> {
  const { page, close } = await loadWallSettled(link, size);
  try {
    return await page.evaluate(() => {
      /** The cascade's size times every transform above it — what is drawn. */
      const scaleOf = (element: Element): number => {
        let scale = 1;
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const matched = /matrix\(([^)]+)\)/.exec(getComputedStyle(node).transform);
          if (matched === null) continue;
          const n = matched[1]!.split(',').map(Number);
          const determinant = Math.abs(n[0]! * n[3]! - n[1]! * n[2]!);
          if (determinant > 0) scale *= Math.sqrt(determinant);
        }
        return scale;
      };

      const runs: { where: string; text: string; font: number }[] = [];
      const seen = new Set<Element>();
      for (const row of document.querySelectorAll('#wall .next .day-row')) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if ((node.nodeValue ?? '').trim() === '') continue;
          const element = node.parentElement;
          if (element === null || seen.has(element)) continue;
          seen.add(element);
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          runs.push({
            where: String(element.className).trim().split(/\s+/)[0] ?? element.tagName,
            text: (element.textContent ?? '').trim().slice(0, 60),
            font: +(parseFloat(style.fontSize) * scaleOf(element)).toFixed(2),
          });
        }
      }

      const running: number[] = [];
      const ordinary: number[] = [];
      for (const entry of document.querySelectorAll('#wall .next .dr-ev')) {
        const height = +entry.getBoundingClientRect().height.toFixed(2);
        (entry.querySelector('.dr-ev-bar') === null ? ordinary : running).push(height);
      }

      const barNode = document.querySelector('#wall .next .dr-ev-bar');
      const entry = barNode?.closest('.dr-ev') ?? null;
      const fillNode = barNode?.querySelector('.dr-ev-bar-fill') ?? null;
      const timeNode = entry?.querySelector('.dr-ev-time') ?? null;
      const spanNode = entry?.querySelector('.dr-ev-span') ?? null;
      /*
       * The time's *text* box, not its element box. The whole argument for
       * putting the bar here is that digits and a colon have no descenders, so
       * what has to be clear is the ink — and only a Range reports that.
       */
      let timeTextBottom = 0;
      if (timeNode !== null) {
        const text = [...timeNode.childNodes].find(
          (child) => child.nodeType === 3 && (child.textContent ?? '').trim() !== '',
        );
        if (text !== undefined) {
          const range = document.createRange();
          range.selectNodeContents(text);
          timeTextBottom = range.getBoundingClientRect().bottom;
        }
      }
      const bar =
        barNode === null || entry === null
          ? undefined
          : (() => {
              const box = barNode.getBoundingClientRect();
              const around = entry.getBoundingClientRect();
              return {
                position: getComputedStyle(barNode).position,
                height: +box.height.toFixed(2),
                width: +box.width.toFixed(2),
                fill: fillNode === null ? 0 : +fillNode.getBoundingClientRect().width.toFixed(2),
                insideEntry: box.top >= around.top - 0.5 && box.bottom <= around.bottom + 0.5,
                clearOfTimeText: timeTextBottom === 0 ? -1 : +(box.top - timeTextBottom).toFixed(2),
                aboveSpanText:
                  spanNode === null || box.bottom <= spanNode.getBoundingClientRect().top + 0.5,
                withinTimeColumn:
                  timeNode !== null &&
                  box.right <= (entry.querySelector('.dr-ev-title')?.getBoundingClientRect().left ?? 0) + 0.5,
              };
            })();

      return { runs, running, ordinary, spanned: spanNode !== null, bar };
    });
  } finally {
    await close();
  }
}

const WALL = { width: 1080, height: 1920 } as const;

const describeRuns = (runs: readonly Run[]): readonly string[] =>
  runs.map((run) => `${run.where} "${run.text}" at ${run.font.toFixed(1)}px`);

describe('a running event costs the agenda nothing', () => {
  /**
   * The fault, stated as the household meets it.
   *
   * This is the assertion that was red before the fix and the reason the issue
   * exists: not "the bar is misplaced" but "an event happening now takes a word
   * off the wall". Zero is the right bar because
   * `browser-classic-proportions` already holds the quiet version of this same
   * wall to zero — so anything this file finds is the running event's doing.
   */
  it(
    'draws every agenda run above the legibility floor while an event is running',
    async () => {
      const agenda = await measureAgenda(liveLink, WALL);
      expect(agenda.running.length, 'no event was running — the fixture is not live').toBe(1);
      expect(agenda.runs.length, 'the agenda drew some words').toBeGreaterThan(8);

      const under = agenda.runs.filter((run) => run.font < FLOOR_PX);
      expect(
        under.length,
        `${under.length} of ${agenda.runs.length} agenda runs are below the ${FLOOR_PX}px ` +
          `floor:\n${describeRuns(under).join('\n')}`,
      ).toBe(0);
    },
    SLOW,
  );

  /**
   * And the same wall without it, so the comparison is the assertion.
   *
   * Every glyph is identical between these two walls — the fixture moves one
   * event's end time and the time column renders its *start* — so any
   * difference in drawn size is the bar's, and there must not be one. This is
   * what an absolute assertion cannot say: a floor test passes just as happily
   * on a wall that got smaller for some other reason and still cleared 22.
   */
  it(
    'draws the same wall at the same size whether or not an event is running',
    async () => {
      const [still, live] = await Promise.all([
        measureAgenda(quietLink, WALL),
        measureAgenda(liveLink, WALL),
      ]);
      expect(still.running.length, 'the quiet wall has an event running on it').toBe(0);
      expect(live.running.length, 'the live wall has none').toBe(1);
      expect(describeRuns(live.runs)).toEqual(describeRuns(still.runs));
    },
    SLOW,
  );

  /**
   * And the mechanism, so a later change that reintroduces it says why.
   *
   * A height comparison rather than a reading of `position`: the declaration is
   * not the thing that matters, since an out-of-flow bar that grew a margin
   * would cost exactly the same row. Every entry on this wall carries one line
   * of title, so they are all the same height and the running one is not
   * allowed to be an exception.
   */
  it(
    'gives a running entry the same height as every other one',
    async () => {
      const agenda = await measureAgenda(liveLink, WALL);
      expect(agenda.ordinary.length, 'nothing to compare against').toBeGreaterThan(0);
      const tallest = Math.max(...agenda.ordinary);
      for (const height of agenda.running) {
        expect(height, 'the running entry is taller than the entries around it').toBeLessThanOrEqual(
          tallest + 0.5,
        );
      }
    },
    SLOW,
  );

  /**
   * And it sits under the *time*, not at the foot of the entry.
   *
   * The two are the same place on an ordinary entry and different the moment
   * the entry has a second row, which for a timed event means one thing: it ran
   * past midnight, so the display draws "Day 2 of 2" under its title. There the
   * foot of the entry is under that line — and "Day" carries a 'y'. So the bar
   * has to keep the time's row, and this is the only fixture in the suite that
   * can say whether it does.
   */
  it(
    'keeps the time\u2019s row when the entry has a second one',
    async () => {
      const agenda = await measureAgenda(overnightLink, WALL);
      expect(agenda.running.length, 'the overnight event is not running').toBe(1);
      expect(agenda.spanned, 'the running entry drew no span row').toBe(true);
      const bar = agenda.bar;
      expect(bar).toBeDefined();
      if (bar === undefined) return;
      expect(bar.clearOfTimeText, 'the bar is not under the time').toBeGreaterThanOrEqual(0);
      expect(
        bar.aboveSpanText,
        'the bar dropped to the foot of the entry, over the span line',
      ).toBe(true);
    },
    SLOW,
  );

  /**
   * Costing nothing is only half of it: a bar nobody can see costs nothing too.
   *
   * The first version of this fix drew a bar **zero pixels wide** and passed
   * every height assertion above — an absolutely positioned grid item with auto
   * insets is shrink-to-fit, and an empty track shrinks to nothing. So the bar
   * has to be drawn, inside its own entry, and clear of the ink above it, which
   * is the whole reason it sits under the time rather than under the title:
   * the title's text box ends 0.83px above its line box, and a bar there slices
   * the bottom off a descender.
   */
  it(
    'still draws the bar, inside its entry and clear of the time',
    async () => {
      const agenda = await measureAgenda(liveLink, WALL);
      const bar = agenda.bar;
      expect(bar, 'no progress bar was drawn').toBeDefined();
      if (bar === undefined) return;
      expect(bar.position, 'in flow, so it costs a row').toBe('absolute');
      expect(bar.height, 'no height — drawn as nothing').toBeGreaterThan(0);
      expect(bar.width, 'no width — drawn as nothing').toBeGreaterThan(0);
      expect(bar.insideEntry, 'the bar hangs outside the entry it belongs to').toBe(true);
      expect(bar.withinTimeColumn, 'the bar spans the entry rather than the time column').toBe(true);
      expect(bar.clearOfTimeText, 'the bar overlaps the time it sits under').toBeGreaterThanOrEqual(0);
      /*
       * Half an hour into an hour. A fill that is all or nothing means the
       * fraction reached the renderer as a constant rather than as a clock,
       * which is a bar that is drawn and says nothing.
       */
      expect(bar.fill).toBeGreaterThan(bar.width * 0.2);
      expect(bar.fill).toBeLessThan(bar.width * 0.8);
    },
    SLOW,
  );
});
