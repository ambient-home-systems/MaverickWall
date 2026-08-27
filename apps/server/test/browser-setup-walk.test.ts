/**
 * The first run, walked in a real browser from a database that has never been
 * touched (RFC 009 Phase 2).
 *
 * This exists because an audit reported that the wizard went
 * Account → Timezone → Calendar → *done*, never showing step 4 — on a session
 * that had re-entered the wizard partway through an earlier run. That is a
 * different journey and it explains the observation exactly: setup is marked
 * complete after the *timezone*, so `GET /setup` on a re-entry redirects
 * straight to `/setup/done` and steps 3 and 4 are behind it. Nothing about a
 * clean first run was broken, and there was no test that could say so.
 *
 * So this one walks the clean path in a browser, pressing the buttons a
 * household presses, over both ways out of step 3: skipping the calendar, and
 * adding a real feed served on loopback. Not `app.fetch` with hand-built
 * bodies — the thing under test is where a *form* takes you, and every one of
 * these actions is a relative `action` resolved against the page's `<base>`,
 * which is exactly the class of thing a hand-built request cannot see.
 *
 * It also pins the stepper against the pages it leads to. A chip is a promise
 * about the next screen, and the two lived in different files with nothing
 * comparing them: the chip read "2 · Timezone" over a page headed "Where is
 * this wall?", while step 4 was "Where & who" — two steps claiming the same
 * subject, and a chip contradicting its own heading.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { WIZARD_STEP_LABELS } from '../src/http/html.js';

/** Long: a server, a feed, a browser and four full page loads. */
const SLOW = 120_000;

const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

/**
 * Wait for whatever document the last press produced.
 *
 * Deliberately not `waitForSelector` on something the *expected* page has: a
 * button wired to the wrong screen would then fail as a thirty-second timeout
 * hunting for an element, which says nothing about where the walk went. This
 * settles wherever it landed and lets the path assertion name it.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

/** What the household is standing on: the URL's path, the chip lit, the heading. */
interface Where {
  readonly path: string;
  /** The `.on` chip's label with its "N · " prefix removed, or undefined. */
  readonly chip: string | undefined;
  /** Which chip is lit, 1-based, or undefined when the bar is absent. */
  readonly index: number | undefined;
  readonly heading: string;
  /** Every chip the bar advertises, in order. */
  readonly chips: readonly string[];
}

async function whereAmI(page: Page): Promise<Where> {
  const chips = await page.$$eval('.steps .step span', (nodes) =>
    nodes.map((n) => (n.textContent ?? '').replace(/^\s*\d+\s*·\s*/, '').trim()),
  );
  const index = await page.$$eval('.steps .step', (nodes) =>
    nodes.findIndex((n) => n.classList.contains('on')),
  );
  const heading = (await page.textContent('h1')) ?? '';
  return {
    path: new URL(page.url()).pathname,
    chips,
    chip: index >= 0 ? chips[index] : undefined,
    index: index >= 0 ? index + 1 : undefined,
    heading: heading.trim(),
  };
}

/** A clean installation with the wizard untouched, and a browser page on it. */
async function cleanFirstRun(options: { feed?: boolean } = {}): Promise<{
  install: Installation;
  page: Page;
}> {
  const made = await install({ wizard: false, ...(options.feed === true ? { feed: true } : {}) });
  installations.push(made);
  const context = await (await browser()).newContext();
  return { install: made, page: await context.newPage() };
}

/** Step 1 and step 2, typed and pressed. Leaves the page on step 3. */
async function throughTimezone(page: Page, made: Installation): Promise<Where[]> {
  const seen: Where[] = [];

  await page.goto(`${made.base}/setup?token=${made.setupToken}`);
  seen.push(await whereAmI(page));

  await page.fill('input[name="name"]', 'Household');
  await page.fill('input[name="email"]', 'family@home.local');
  await page.fill('input[name="password"]', 'correct-horse-battery');
  await page.fill('input[name="confirm"]', 'correct-horse-battery');
  await page.click('form[action$="setup/account"] button[type="submit"]');
  await settle(page);
  seen.push(await whereAmI(page));

  await page.selectOption('select[name="timezone"]', 'Europe/London');
  await page.click('form[action$="setup/household"] button[type="submit"]');
  await settle(page);
  seen.push(await whereAmI(page));
  return seen;
}

describe('the wizard, walked clean in a browser', () => {
  it(
    'reaches all four steps when the calendar is skipped',
    async () => {
      const { install: made, page } = await cleanFirstRun();
      const seen = await throughTimezone(page, made);

      /*
       * Step 3's low-emphasis way out, found by how it *looks* rather than by
       * where it points. Selecting it on its own action would make a skip
       * wired to the wrong screen fail as a thirty-second timeout looking for
       * a button, instead of as a walk that ended up somewhere else.
       */
      await page.click('.btn-text');
      await settle(page);
      seen.push(await whereAmI(page));

      expect(seen.map((one) => one.path)).toEqual([
        '/setup',
        '/setup',
        '/setup/calendar',
        '/setup/place',
      ]);
      // Every advertised step was lit, in order, and step 4 among them.
      expect(seen.map((one) => one.index)).toEqual([1, 2, 3, 4]);

      // And the last step's own skip finishes, rather than looping.
      await page.click('.btn-text');
      await settle(page);
      expect(new URL(page.url()).pathname).toBe('/setup/done');
      expect(await page.textContent('h1')).toContain('That is everything');
    },
    SLOW,
  );

  it(
    'reaches step 4 when a real calendar is added instead of skipped',
    async () => {
      const { install: made, page } = await cleanFirstRun({ feed: true });
      await throughTimezone(page, made);

      const feedUrl = made.feedUrl;
      expect(feedUrl).toBeTypeOf('string');

      await page.fill('input[name="name"]', 'Family');
      await page.fill('input[name="url"]', feedUrl as string);
      await page.click('form[action$="setup/calendar"] button[type="submit"]');

      /*
       * A loopback address over plain http is refused until the household says
       * so, and the wizard only draws the three opt-ins once one is needed —
       * so this is two submissions, which is what the household does too.
       */
      await settle(page);
      await page.check('input[name="allow_loopback"]');
      await page.check('input[name="allow_http"]');

      await page.click('form[action$="setup/calendar"] button[type="submit"]');
      await settle(page);
      const arrived = await whereAmI(page);
      expect(arrived.path).toBe('/setup/place');
      expect(arrived.index).toBe(4);

      // The calendar really was stored, so this is the *success* branch of step
      // 3 rather than a second refusal that happened to land somewhere.
      const stored = made.db
        .prepare('SELECT COUNT(*) AS total FROM calendar_sources')
        .get() as { total: number };
      expect(stored.total).toBe(1);
    },
    SLOW,
  );

  it(
    'never lets two steps claim the same subject, or a chip contradict its heading',
    async () => {
      const { install: made, page } = await cleanFirstRun();
      const seen = await throughTimezone(page, made);
      await page.click('.btn-text');
      await settle(page);
      seen.push(await whereAmI(page));

      // The bar the household reads is the list the server declares.
      for (const one of seen) expect(one.chips).toEqual([...WIZARD_STEP_LABELS]);

      /*
       * A label's subject is the words in it that are not punctuation. Chips
       * are two words at most, so there is nothing to filter beyond the "&".
       */
      const subject = (label: string): string[] =>
        label
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((word) => word.length > 2);

      // No two chips claim the same thing. "Timezone" and "Where & who" passed
      // this; "Where is this wall?" as step 2's heading did not.
      const subjects = WIZARD_STEP_LABELS.map(subject);
      for (let a = 0; a < subjects.length; a++) {
        for (let b = a + 1; b < subjects.length; b++) {
          const shared = (subjects[a] ?? []).filter((word) => (subjects[b] ?? []).includes(word));
          expect(
            shared,
            `steps ${a + 1} and ${b + 1} both claim ${shared.join(', ')}`,
          ).toEqual([]);
        }
      }

      for (const one of seen) {
        const heading = one.heading.toLowerCase();
        const index = (one.index ?? 0) - 1;
        const mine = subjects[index] ?? [];

        // The chip names what the page under it is about…
        for (const word of mine) {
          expect(
            heading.includes(word),
            `step ${index + 1}'s chip says "${one.chip}" and its heading is "${one.heading}"`,
          ).toBe(true);
        }

        // …and nothing else's. This is the half that catches a heading which
        // is *silent* about its own step while answering another one's.
        for (let other = 0; other < subjects.length; other++) {
          if (other === index) continue;
          for (const word of subjects[other] ?? []) {
            expect(
              heading.includes(word),
              `step ${index + 1}'s heading "${one.heading}" claims step ${other + 1}'s subject`,
            ).toBe(false);
          }
        }
      }
    },
    SLOW,
  );
});
