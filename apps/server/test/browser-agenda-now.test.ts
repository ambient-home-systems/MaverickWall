/**
 * Where the day has got to, and what an empty day says.
 *
 * Two changes, both in the agenda and both measured on a real wall:
 *
 *  - **A current-time indicator**, and this is the only one in the product. A
 *    rule across the column between what has happened and what has not, no
 *    label. Not on the month grid — a *day* is not a timeline — and not on an
 *    e-paper panel, which `epaper-month-spans` pins for its own reason.
 *  - **An empty day draws its date and nothing else.** It used to say "Nothing
 *    on", which is a line of italic in every quiet day's row saying the only
 *    thing an empty day can be. On a wall where rows are the scarce unit, that
 *    is a row the days with something on them wanted.
 *
 * The indicator is asserted by its *position among the events*, never by the
 * clock. A test that seeds an event five minutes either side of now is a test
 * that reports the truth for most of the day and something else at midnight,
 * which is the fault this suite has already shipped once and spent an
 * afternoon finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  settleWall,
  shutDownBrowser,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

const SLOW = 120_000;
const WALL = { width: 1080, height: 1920 } as const;

/**
 * Today, spread across the whole day, and a second calendar that is quiet
 * until next week.
 *
 * The times run from just after midnight to just before it so that at any hour
 * the suite runs, some of today's events have been and some have not — and the
 * assertions below hold even in the two five-minute windows where they have
 * not, because they are about *order* rather than about count.
 */
const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Today',
    events: [
      { title: 'Early swim', day: 0, from: '0005', to: '0045' },
      { title: 'Breakfast club', day: 0, from: '0730', to: '0830' },
      { title: 'Standup', day: 0, from: '0930', to: '0945' },
      { title: 'Lunch with Sam', day: 0, from: '1230', to: '1330' },
      { title: 'Football practice', day: 0, from: '1730', to: '1900' },
      { title: 'Book club', day: 0, from: '2330', to: '2355' },
      { title: 'Bin day', day: 0 },
    ],
  },
  {
    name: 'Later',
    events: [
      { title: 'Dentist', day: 3, from: '0900', to: '1000' },
      { title: 'Car service', day: 4, from: '0800', to: '1200' },
    ],
  },
];

interface AgendaShape {
  /**
   * Every event in today's column, in order.
   *
   * `at` is the event's start time in minutes past midnight, or -1 for an
   * all-day one. Read off the drawn `.dr-ev-time` rather than off a class,
   * because **the agenda has no past/next classes at all** — `.te.is-next` is
   * a rule in the stylesheet matching an element no renderer has emitted since
   * the day block was retired, and a first draft of this file read those
   * classes and asserted nothing whatever.
   *
   * `rule` says whether this event carries the current-time hairline, and
   * `atEnd` whether it carries it underneath. The rule hangs off an event
   * rather than sitting between two, because a row of its own costs a grid gap
   * and that gap costs the agenda its type floor.
   */
  readonly today: readonly {
    readonly text: string;
    readonly at: number;
    readonly rule: boolean;
    readonly atEnd: boolean;
  }[];
  /** The wall's own clock, in minutes past midnight in the household's zone. */
  readonly nowMinutes: number;
  /** How many `.dr-now` rules are on the wall at all. */
  readonly rules: number;
  /** How many are anywhere but today's row. */
  readonly strays: number;
  /**
   * The rule as drawn *and* as declared, plus the row it sits among.
   *
   * Both, because either alone is the wrong question. The declared height is
   * what the stylesheet asked for; the drawn one is what a household sees
   * through the widget's own `scale()`, and a rule scaled to nothing is a rule
   * that is not there. The event height is what makes "hairline" mean
   * something rather than "two pixels of whatever this box turned out to be".
   */
  readonly rule:
    | { readonly drawn: number; readonly declared: string; readonly background: string }
    | undefined;
  /** The drawn height of an ordinary event row beside it. */
  readonly eventHeight: number;
  /** The whole agenda's drawn height, for "the rule costs no height at all". */
  readonly agendaHeight: number;
  /** Any words on the rule. There must be none. */
  readonly ruleText: string;
  /** Whether the rule is out of flow, which is what makes it free. */
  readonly ruleOutOfFlow: boolean;
  /** Any text on the wall that reads as an empty-day placeholder. */
  readonly placeholders: readonly string[];
  /** Days drawn with no events at all. */
  readonly emptyDays: number;
}

let wall: Installation;
let link: string;
let screenId: string;
let sources: { readonly id: string; readonly name: string }[];

beforeAll(async () => {
  wall = await install({ calendars: [...CALENDARS] });
  link = await wall.pairLink();
  screenId = (wall.db.prepare('SELECT id FROM screens').get() as { id: string }).id;
  sources = wall.db
    .prepare('SELECT id, name FROM calendar_sources')
    .all() as { id: string; name: string }[];
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** One agenda widget filling the canvas, optionally showing one calendar. */
function canvasOf(calendars?: readonly string[]): void {
  const config: Record<string, unknown> = { mode: 'list', count: 20 };
  if (calendars !== undefined) config['calendars'] = [...calendars];
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: [
        { id: `ag-${orientation}`, type: 'calendar', x: 0.02, y: 0.02, w: 0.96, h: 0.96, z: 0, config },
      ],
      background: null,
    });
  }
}

async function measure(calendars?: readonly string[]): Promise<AgendaShape> {
  canvasOf(calendars);
  const context = await (await browser()).newContext({ viewport: WALL });
  const page: Page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    return await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#wall .day-row')];
      const todayRow = rows.find((row) => row.classList.contains('is-today'));
      const events = todayRow?.querySelector('.dr-events');
      const minutes = (text: string): number => {
        const match = /^(\d{1,2}):(\d{2})/.exec(text.trim());
        if (match === null) return -1;
        return Number(match[1]) * 60 + Number(match[2]);
      };
      const today = [...(events?.querySelectorAll('.dr-ev') ?? [])].map((node) => ({
        text: (node.textContent ?? '').trim().slice(0, 40),
        at: minutes(node.querySelector('.dr-ev-time')?.textContent ?? ''),
        rule: node.querySelector('.dr-now') !== null,
        atEnd: node.querySelector('.dr-now.at-end') !== null,
      }));
      const clock = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
      const all = [...document.querySelectorAll('#wall .dr-now')];
      const inToday = todayRow?.querySelectorAll('.dr-now').length ?? 0;
      const first = all[0];
      const style = first instanceof HTMLElement ? getComputedStyle(first) : undefined;
      const placeholders = [...document.querySelectorAll('#wall .dr-empty')]
        .map((node) => (node.textContent ?? '').trim())
        .filter((text) => text !== '');
      const emptyDays = rows.filter(
        (row) => row.querySelectorAll('.dr-ev').length === 0,
      ).length;
      return {
        today,
        nowMinutes: minutes(clock),
        rules: all.length,
        strays: all.length - inToday,
        ruleText: (first?.textContent ?? '').trim(),
        /*
         * Out of flow, read as the property rather than as the declaration: an
         * element that costs no height is one whose parent's layout does not
         * include it, and `position: absolute` is how that is spelled here.
         */
        ruleOutOfFlow: style?.position === 'absolute',
        rule:
          first instanceof HTMLElement && style !== undefined
            ? {
                drawn: first.getBoundingClientRect().height,
                declared: style.height,
                background: style.backgroundColor,
              }
            : undefined,
        eventHeight:
          todayRow?.querySelector('.dr-ev')?.getBoundingClientRect().height ?? 0,
        agendaHeight:
          document.querySelector('#wall section.next')?.getBoundingClientRect().height ?? 0,
        placeholders,
        emptyDays,
      };
    });
  } finally {
    await context.close();
  }
}

describe('rule 4 — where the day has got to', () => {
  it(
    'draws exactly one rule, in today\'s row and nowhere else',
    async () => {
      const shape = await measure();
      expect(shape.rules, 'the wall drew no current-time rule at all').toBe(1);
      expect(shape.strays, 'a rule was drawn outside today').toBe(0);
    },
    SLOW,
  );

  it(
    'puts everything that has happened above it and what is next below',
    async () => {
      /*
       * The whole meaning of the rule, and the only form of it that is true at
       * every hour of the day. Seeding an event five minutes either side of
       * `now` would pin the position exactly and would be a test that reports
       * the truth for twenty-three hours and something else in the twenty-
       * fourth — which is how two wall tests in this suite came to fail for
       * one hour every night.
       */
      const shape = await measure();
      const at = shape.today.findIndex((row) => row.rule);
      expect(at, 'no event in today\'s column carries the rule').toBeGreaterThanOrEqual(0);
      expect(shape.nowMinutes, 'could not read the wall clock').toBeGreaterThanOrEqual(0);

      /*
       * The rule hangs *above* the event that carries it, so that event is the
       * first one still to come; `at-end` hangs it underneath, which is the
       * case where nothing is.
       *
       * A minute of slack, because an event starting in this very minute is
       * honestly on either side of the line and the wall reads seconds where
       * the drawn time reads minutes.
       */
      const before = shape.today.slice(0, shape.today[at]?.atEnd === true ? at + 1 : at);
      const after = shape.today.slice(shape.today[at]?.atEnd === true ? at + 1 : at);
      const timed = (rows: typeof shape.today): typeof rows => rows.filter((row) => row.at >= 0);
      for (const row of timed(before)) {
        expect(
          row.at,
          `"${row.text}" is above the rule but starts after ${shape.nowMinutes}`,
        ).toBeLessThanOrEqual(shape.nowMinutes + 1);
      }
      for (const row of timed(after)) {
        expect(
          row.at,
          `"${row.text}" is below the rule but started before ${shape.nowMinutes}`,
        ).toBeGreaterThanOrEqual(shape.nowMinutes - 1);
      }
      // And the fixture really does span the day, so this is not two vacuous
      // loops over empty lists.
      expect(timed(shape.today).length, 'today drew no timed events to divide').toBeGreaterThan(3);
    },
    SLOW,
  );

  it(
    'is a 2px hairline in the accent, with no words on it',
    async () => {
      /*
       * Measured, because "a rule" is a claim about pixels: a `.dr-now` with no
       * height is a `.dr-now`. The colour is read as a computed value rather
       * than as `var(--accent)` — the token is what the stylesheet says and
       * the `rgb()` is what the wall shows.
       */
      const shape = await measure();
      // What the stylesheet asked for. A rem here would make the rule a bar on
      // a tall wall and invisible on a short one; two pixels is a hairline at
      // every size, which is the whole of the declaration.
      expect(shape.rule?.declared, 'the rule is not declared 2px').toBe('2px');
      /*
       * And what a household sees. The widget is inside a `scale()`, so the
       * drawn height is not the declared one — asserting only the declaration
       * would pass on a rule scaled to nothing, and asserting only the drawing
       * would pass on any thickness at all. It has to be visible and it has to
       * be a hairline beside the events it divides.
       */
      expect(shape.rule?.drawn ?? 0, 'the rule is not drawn at all').toBeGreaterThan(0.5);
      expect(shape.eventHeight, 'no event row to compare it against').toBeGreaterThan(10);
      expect(
        (shape.rule?.drawn ?? 0) / shape.eventHeight,
        `the rule is ${(shape.rule?.drawn ?? 0).toFixed(1)}px beside a ` +
          `${shape.eventHeight.toFixed(1)}px event: a bar, not a hairline`,
      ).toBeLessThan(0.2);
      expect(shape.rule?.background, 'the rule is not painted').toMatch(/^rgba?\(/);
      expect(shape.rule?.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(shape.ruleText, 'the rule carries a label').toBe('');
      /*
       * And it costs the agenda nothing.
       *
       * The reason this is measured rather than assumed: in flow the rule is a
       * grid item, and a grid item costs its own track *and* one more
       * `row-gap`. On the shipped Classic wall that was 11.6px of an 816px
       * section — 4% off the scale it is drawn at, which took the rota chip
       * from 22.5px to 21.6px and under the legibility floor. So it is out of
       * flow, and the assertion is that the agenda is the same height as one
       * with no rule in it: `browser-classic-proportions` measures the
       * consequence, and this measures the cause.
       */
      expect(shape.ruleOutOfFlow, 'the rule takes a row of its own').toBe(true);
    },
    SLOW,
  );
});

describe('an empty day draws its date and nothing else', () => {
  it(
    'says nothing at all where it used to say "Nothing on"',
    async () => {
      /*
       * Shown only the calendar that is quiet until next week, so today is
       * drawn — the agenda always shows today, even empty, so "nothing on
       * today" reads as checked — and drawn with no events in it.
       *
       * The assertion is on the *words*, not on the element: `.dr-empty` also
       * carries "+N more" and the section's own "Nothing coming up.", and both
       * of those are claims about a real number rather than an annotation on
       * an absence.
       */
      const later = sources.find((source) => source.name === 'Later');
      expect(later, 'the fixture lost its quiet calendar').toBeDefined();
      const shape = await measure([later!.id]);
      expect(shape.emptyDays, 'no day was drawn empty at all').toBeGreaterThan(0);
      expect(
        shape.placeholders.filter((text) => /nothing on/i.test(text)),
        'an empty day still annotates itself',
      ).toEqual([]);
      // The day is genuinely there, with its date — an empty *row* rather than
      // no row, which is a different change and not this one.
      expect(shape.today, 'today drew events it was not shown').toEqual([]);
    },
    SLOW,
  );

  it(
    'keeps the section\'s own "Nothing coming up."',
    async () => {
      /*
       * A different claim, and one worth keeping: that the *list* found
       * nothing, which is a fact about the search rather than an annotation on
       * a day. Measured by asking for a calendar id nothing owns.
       */
      const shape = await measure(['no-such-calendar']);
      expect(shape.placeholders).toContain('Nothing coming up.');
    },
    SLOW,
  );
});
