import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEARDOWN,
  equipHousehold,
  HOUSEHOLD_CALENDARS,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

/**
 * One wall, one language.
 *
 * The display formatted its dates in two locales at once. Four call sites in
 * `viewmodel.ts` said `en-GB`, and two — the Swiss month's heading, and the
 * chore board's weekday column in `render.ts` — said `undefined`, which is the
 * *device's*. Measured on a real wall under a French browser, that drew
 * `<h1>septembre 2026</h1>` directly above `Sun Mon Tue Wed Thu Fri Sat`: one
 * widget, two languages, adjacent.
 *
 * The assertion is that **the wall draws the same words whatever the device
 * is set to**, rather than that any particular string is English. That is the
 * invariant the fix actually establishes, it needs no list of the six
 * formatters to stay current, and it goes red the moment either `undefined`
 * comes back — which a unit test cannot do, because the runner's own locale is
 * whatever it is and `en-GB` and `en-US` agree about "Wed".
 *
 * Why pinned rather than following the device is argued at `DISPLAY_LOCALE`:
 * the e-paper renderer formats on the *server*, where there is no device to
 * ask, so a wall that followed its browser would draw different weekday names
 * from the panel following that wall.
 */

process.env['TZ'] = 'UTC';
const SLOW = 240_000;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');

  /*
   * A canvas built for this question rather than the Classic seed.
   *
   * Both device-locale sites have to be *visible* or this measures nothing,
   * and on the seeded wall neither was. The month heading draws only in the
   * Swiss cell treatment; the weekday column draws only on a chore board, and
   * in Classic's 475x173 shift slot the density tier hides six of its seven
   * days — leaving one visible `ch-dow` reading "Today", which is a literal
   * and identical in every language. The first draft of this file asserted
   * that a `ch-dow` existed, found that one, and passed while the fault it
   * exists for was invisible.
   */
  wall.db
    .prepare(
      `INSERT INTO chores (id, name, schedule, person_id, paused, sort_order, created_at, updated_at)
       VALUES ('c-bins', 'Take the bins out', ?, NULL, 0, 0, ?, ?)`,
    )
    .run(JSON.stringify({ kind: 'daily' }), wall.now(), wall.now());

  const screen = (wall.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;
  replaceLayout(wall.db, screen, 'portrait', {
    mode: 'freeform',
    aspect: 0.5625,
    widgets: [
      {
        id: 'cal-swiss',
        type: 'calendar',
        x: 0.02, y: 0.02, w: 0.96, h: 0.5, z: 0,
        config: { mode: 'month', cellEvents: 'swiss' },
      },
      {
        // Tall enough that the week board keeps whole days rather than one.
        id: 'chores-week',
        type: 'chores',
        x: 0.02, y: 0.54, w: 0.96, h: 0.44, z: 0,
        config: { mode: 'week' },
      },
    ],
    background: null,
  });
}, SLOW);

afterAll(async () => {
  await shutDownBrowser();
  await wall?.dispose();
}, TEARDOWN);

/** Every visible run of text on the wall, in document order. */
const TEXT = `
(() => {
  const out = [];
  const walker = document.createTreeWalker(
    document.getElementById('wall'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = (n.nodeValue || '').trim();
    if (text === '') continue;
    const el = n.parentElement;
    if (el === null) continue;
    let hidden = false;
    for (let p = el; p !== null; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
    }
    if (hidden) continue;
    out.push(String(el.className || el.tagName.toLowerCase()) + ' | ' + text);
  }
  return out;
})()`;

/**
 * The wall as a device set to `locale` would draw it, past the font race.
 *
 * `loadWallSettled` rather than a `goto` and a settle, and that is not a
 * tidy-up — it is the whole reason this file was wrong. Every reading here
 * comes from a *separate browser context*, because a context's locale cannot
 * be changed after it is made, and a fresh context has a cold HTTP cache: the
 * density tiers are resolved against whatever face has arrived, so the first
 * load and the third can cut a weekday head differently for reasons that have
 * nothing to do with language.
 *
 * Measured on CI, that is exactly what happened — the en-GB reading drew
 * `Sun Mon Tue…` and the fr-FR one drew `S M T W T F S`, which the positional
 * diff below then reported as 53 differing runs because one insertion shifts
 * everything after it. The strings were identical; the *forms* were not.
 * `loadWallSettled` holds the first manifest back and reloads, which is the
 * steady state a wall that has been hanging for a while is in, and is
 * repeatable across contexts.
 */
async function wallAs(locale: string): Promise<string[]> {
  const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 }, { locale });
  try {
    return (await page.evaluate(TEXT)) as string[];
  } finally {
    await close();
  }
}

describe('the wall under a device that is not English', () => {
  it('draws exactly the same words in French, German and British English', async () => {
    const british = await wallAs('en-GB');

    // The premise, twice over: the two formatters that used to read the device
    // must actually be on this wall, or every assertion below is about a wall
    // that could not have shown the fault.
    expect(
      british.some((run) => run.startsWith('hz-title ')),
      'the Swiss month heading is not on this wall',
    ).toBe(true);
    /*
     * A *formatted* weekday, not merely a `ch-dow`. Today's own head is the
     * literal "Today", which reads the same in every language — accepting it
     * is how the first draft of this file passed with the fault reinstated.
     */
    expect(
      british.filter((run) => run.startsWith('ch-dow | ') && run !== 'ch-dow | Today').length,
      'the chore board drew no weekday but its own "Today"',
    ).toBeGreaterThan(0);

    for (const locale of ['fr-FR', 'de-DE']) {
      const other = await wallAs(locale);
      const differing = other.filter((run, i) => run !== british[i]);
      expect(
        differing.slice(0, 8),
        `${locale}: ${differing.length} run(s) differ from en-GB — the wall changed ` +
          `language with the device`,
      ).toEqual([]);
      expect(other.length).toBe(british.length);
    }
  }, SLOW);
});
