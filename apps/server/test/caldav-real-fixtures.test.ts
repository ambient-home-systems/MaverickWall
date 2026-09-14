import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALDAV_NS,
  CALENDARSERVER_NS,
  DAV_NS,
  hrefIn,
  isCalendarCollection,
  prop,
  readMultistatus,
} from '../src/caldav/multistatus.js';
import { splitCalendarData } from '../src/caldav/query.js';
import { expandCalendar } from '@maverick-wall/calendar';

/**
 * The reader against a real producer's output (RFC 013 §6.8, §11).
 *
 * §6.8 names the way this reader goes wrong — "a reader that handles one
 * server's prefixes and not another's works against Nextcloud and fails against
 * iCloud" — and says the mitigation is fixtures from real servers, byte for
 * byte, the way `packages/calendar/test/fixtures/real/` already does.
 *
 * These are captured from a real **SabreDAV 4.7.1**, which is the library
 * Nextcloud's own calendar app is built on, stood up locally with three
 * calendars on one credential. That is not the same as Nextcloud and it is not
 * iCloud; `real/MISSING.md` says which files are still wanted and why. What it
 * is, is output nobody here authored — and the difference showed immediately:
 * this server writes the CalDAV namespace as `cal:` where every synthetic
 * fixture in the corpus writes `C:`, which is precisely the class of difference
 * §6.8 is worried about.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const real = (name: string): string =>
  readFileSync(join(HERE, 'fixtures', 'caldav', 'real', name), 'utf8');

describe('a real SabreDAV, byte for byte', () => {
  it('reads the principal out of a namespace spelling no synthetic fixture uses', () => {
    const document = readMultistatus(real('sabredav-principal.xml'));
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(hrefIn(document.responses[0] as never, DAV_NS, 'current-user-principal')).toBe(
      '/principals/household/',
    );
    // The thing worth pinning: the prefixes this server actually chose. A
    // reader that assumed `C:` for CalDAV would read every calendar on it as
    // nothing at all.
    expect(real('sabredav-home-set-href.xml')).toContain('<cal:calendar-home-set>');
    expect(real('sabredav-home-set-href.xml')).not.toContain('<C:calendar-home-set>');
  });

  it('finds the calendar home set', () => {
    const document = readMultistatus(real('sabredav-home-set-href.xml'));
    if (!document.ok) throw new Error('unreadable');
    expect(hrefIn(document.responses[0] as never, CALDAV_NS, 'calendar-home-set')).toBe(
      '/calendars/household/',
    );
  });

  it('picks three calendars out of six collections, and reads their CTags', () => {
    const document = readMultistatus(real('sabredav-home-set.xml'));
    if (!document.ok) throw new Error('unreadable');

    /*
     * Six responses: the container, three calendars, and SabreDAV's own inbox
     * and outbox. The last two are the case a reader gets wrong by reading
     * every `prop` regardless of the `status` beside it — this server answers
     * them with **two** propstats, a 200 for `resourcetype` and a 404 for the
     * three properties they do not have, which is the shape the corpus's
     * synthetic Nextcloud fixture claims to model and this one confirms.
     */
    expect(document.responses).toHaveLength(6);
    const calendars = document.responses.filter(isCalendarCollection);
    expect(calendars.map((response) => prop(response, DAV_NS, 'displayname')?.text)).toEqual([
      'Home',
      "Kids' school",
      'Work',
    ]);
    expect(calendars.map((response) => prop(response, CALENDARSERVER_NS, 'getctag')?.text)).toEqual([
      'http://sabre.io/ns/sync/1',
      'http://sabre.io/ns/sync/2',
      'http://sabre.io/ns/sync/2',
    ]);
    // And the inbox and outbox are not offered as calendars, which is what the
    // 404 propstat is there to make a reader get right.
    expect(calendars).toHaveLength(3);
  });

  it('reads the CTag off a bare PROPFIND, which is what a sync sends', () => {
    const document = readMultistatus(real('sabredav-ctag.xml'));
    if (!document.ok) throw new Error('unreadable');
    expect(prop(document.responses[0] as never, CALENDARSERVER_NS, 'getctag')?.text).toBe(
      'http://sabre.io/ns/sync/2',
    );
  });

  it('splits a REPORT into whole VCALENDARs that this project’s own parser reads', () => {
    const split = splitCalendarData(real('sabredav-report.xml'));
    if (!split.ok) throw new Error('unreadable');
    expect(split.resources).toHaveLength(1);

    const resource = split.resources[0] as { etag?: string; calendarData: string };
    // The ETag arrives quoted, and the quotes are part of it: an ETag is
    // compared byte for byte and stripping them would mean never matching.
    expect(resource.etag).toBe(`"33f647fecca13ec363deb6e01dda684c"`);

    /*
     * And the end-to-end claim: what a real server hands over goes through
     * *this repository's* expander rather than the server's, which is §6.4's
     * refusal of `<C:expand>` made concrete. The series crosses US
     * spring-forward on 2026-03-08, so an expander that resolved recurrence
     * against anything but local clock readings would land an instance an hour
     * out.
     */
    const expanded = expandCalendar({
      icsText: resource.calendarData,
      targetTimezone: 'America/New_York',
      windowStart: new Date('2026-03-01T00:00:00Z'),
      windowEnd: new Date('2026-04-01T00:00:00Z'),
      maxEvents: 100,
    });
    if (!expanded.ok) throw new Error(`the real resource did not parse: ${expanded.error.message}`);
    expect(expanded.value).toHaveLength(4);
    expect(expanded.value.every((event) => event.title === 'Weekly standup')).toBe(true);

    // 09:00 local on every one of them, across the DST boundary — which is the
    // whole of "recurrence is computed on wall-clock, then anchored".
    const localHours = expanded.value.map((event) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(event.startUtc),
    );
    expect(new Set(localHours)).toEqual(new Set(['09:00']));
    // And the UTC instants are *not* all the same, which is what says the
    // boundary was actually crossed rather than the fixture sitting on one side
    // of it.
    expect(new Set(expanded.value.map((event) => event.startUtc.getUTCHours())).size).toBe(2);
  });
});
