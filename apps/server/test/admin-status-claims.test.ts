/**
 * Three false claims in the admin, pinned by the sentence a household reads.
 *
 * All three were the same class `saved.ts` already has a rule for — "a token is
 * a claim, so check the branch it is on" — applied to status text and status
 * chips rather than to the confirmation strip:
 *
 *  - a calendar whose first sync had not run yet reported "0 events · synced
 *    never", which is *character for character* what a dead feed says. Measured
 *    on a working feed: that for about twenty seconds, then "12 events · synced
 *    1 minute ago" with no user action. The household's first impression of a
 *    calendar that works was a failure state;
 *  - the Overview drew a green "All syncing" over "0 Calendars connected",
 *    because `failing === 0` is true of the empty set;
 *  - and "Today on the wall" headlined the timezone in the largest type on the
 *    page, which reads as the wall's name.
 *
 * Driven through a real installation with a real loopback feed rather than
 * against rows inserted behind it: the "just added" state is a fact about what
 * `POST /admin/calendars` leaves in the database, and a hand-written row proves
 * nothing about that.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { install, type Installation } from './browser-harness.js';
import { firstSyncPending, FIRST_SYNC_WINDOW_MS } from '../src/http/admin.js';

const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(options?: Parameters<typeof install>[0]): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
});

/** The text of the page, tags removed, so an assertion reads what a person reads. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

/** Add a second calendar through the real form, and do *not* sync it. */
async function addUnsynced(home: Installation, name: string): Promise<void> {
  const url = home.feedUrl;
  if (url === undefined) throw new Error('this installation has no feed to add');
  const added = await home.post('/admin/calendars', {
    name,
    url,
    allow_loopback: '1',
    allow_http: '1',
    action: 'save',
  });
  expect(added.status).toBe(302);
}

// ===========================================================================
// 1. A calendar that is syncing must not report itself as never synced
// ===========================================================================

describe('the Calendars screen, on a calendar that has just been added', () => {
  it(
    'says it is syncing, and says it has synced once it has',
    async () => {
      // `feed: true` adds "Family" through the wizard *and* syncs it, so this
      // one page carries both states at once: a settled calendar and a fresh
      // one. Asserting them together is what makes the second sentence mean
      // something — a rule that said "Syncing…" for every row would pass a test
      // that only ever looked at a fresh one.
      const home = await fresh({ feed: true });
      await addUnsynced(home, 'Just added');

      const before = textOf(await (await home.call('/admin/calendars')).text());
      expect(before).toContain('Syncing…');
      // The failure sentence, in the words it was reported in.
      expect(before).not.toContain('synced never');
      // Word-boundaried: the feed carries ten events, and a bare substring
      // match would find "0 events" inside "10 events" and pass over the bug.
      expect(before).not.toMatch(/\b0 events/);
      // And the settled row is untouched by the new branch: exactly one of the
      // two rows reports a count, and it is the one that has synced.
      expect(before.match(/events · synced/g)?.length).toBe(1);

      await home.sync();

      const after = textOf(await (await home.call('/admin/calendars')).text());
      expect(after).not.toContain('Syncing…');
      // Both rows now, each with the count the feed actually carries.
      expect(after.match(/events · synced/g)?.length).toBe(2);
      expect(after).not.toMatch(/\b0 events/);
    },
    SLOW,
  );

  it(
    'confirms the add by saying what happens next',
    async () => {
      const home = await fresh({ feed: true });
      await addUnsynced(home, 'Just added');
      // The strip is drawn from the redirect's `?saved=` token, so this reads
      // the page the household actually lands on.
      const landed = textOf(await (await home.call('/admin/calendars?saved=calendar-added')).text());
      expect(landed).toContain('Calendar added — fetching events now.');
    },
    SLOW,
  );
});

/**
 * The four conditions, each broken on its own.
 *
 * `firstSyncPending` is pure, so the branches it must *not* claim are cheaper to
 * assert here than to arrange four installations for — and each of these is a
 * different way for "Syncing…" to become the false claim it replaced.
 */
describe('firstSyncPending', () => {
  const at = 1_700_000_000_000;
  const fresh_ = {
    lastSuccessAt: null,
    lastError: null,
    enabled: 1,
    createdAt: at - 5_000,
  } as const;

  it('is true only just after a calendar is added', () => {
    expect(firstSyncPending(fresh_, at)).toBe(true);
  });

  it('is false once a sync has succeeded, because there is a real time to report', () => {
    expect(firstSyncPending({ ...fresh_, lastSuccessAt: at - 60_000 }, at)).toBe(false);
  });

  it('is false when there is an error, because the error block is the truth', () => {
    expect(firstSyncPending({ ...fresh_, lastError: 'Could not resolve that host.' }, at)).toBe(
      false,
    );
  });

  it('is false when sync is off, because `ics-sync` skips a disabled source outright', () => {
    expect(firstSyncPending({ ...fresh_, enabled: 0 }, at)).toBe(false);
  });

  it('is false once the window has passed, because a stuck calendar is not syncing', () => {
    expect(firstSyncPending({ ...fresh_, createdAt: at - FIRST_SYNC_WINDOW_MS - 1 }, at)).toBe(
      false,
    );
  });
});

// ===========================================================================
// 2. Zero calendars is not "all syncing"
// ===========================================================================

describe('the Overview calendar chip', () => {
  it(
    'claims nothing about an empty set',
    async () => {
      const home = await fresh();
      const html = await (await home.call('/admin')).text();
      const text = textOf(html);

      expect(text).toContain('0 Calendars connected');
      expect(text).not.toContain('All syncing');
      expect(text).toContain('None yet');
      // Neutral, not green: the dot is what carries the colour, and a chip with
      // no calendars behind it must not draw the well one.
      expect(html).toMatch(/<span class="tag">None yet<\/span>/);
    },
    SLOW,
  );

  it(
    'says all syncing once there is a calendar that is',
    async () => {
      const home = await fresh({ feed: true });
      const text = textOf(await (await home.call('/admin')).text());
      expect(text).toContain('1 Calendars connected'.replace('Calendars', 'Calendar'));
      expect(text).toContain('All syncing');
      expect(text).not.toContain('None yet');
    },
    SLOW,
  );
});

// ===========================================================================
// 3. The timezone is not the headline
// ===========================================================================

describe('the "Today on the wall" card', () => {
  it(
    'headlines today and demotes the zone to the supporting line',
    async () => {
      // A named zone rather than the default, so "the headline is not the zone"
      // is a claim about this card and not about `Etc/UTC` happening to be
      // absent from a date.
      const home = await fresh({ timezone: 'Europe/London' });
      const html = await (await home.call('/admin')).text();

      const big = /<div class="today-big">([^<]*)<\/div>/.exec(html)?.[1];
      expect(big).toBeDefined();
      expect(big).not.toBe('Europe/London');
      // Today, in the household's own zone — the same formatter the card uses,
      // computed here from the zone rather than copied from the page.
      const today = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date());
      expect(big).toBe(today);

      // And the zone is still stated, on the line the other facts live on.
      // That line is `.sub` rather than `.host`: `.host` was one class doing
      // two jobs and now means machine identity only, so a sentence counting
      // calendars and naming a zone moved to the prose half of the split.
      const card = /<div class="card today-card">([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? '';
      const sub = /<div class="sub">([^<]*)<\/div>/.exec(card)?.[1];
      expect(sub, 'the supporting line is missing from the card entirely').toBeDefined();
      expect(sub).toContain('Europe/London');
    },
    SLOW,
  );
});
