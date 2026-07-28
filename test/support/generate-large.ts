/**
 * Builds the requirement-20 feed at test time rather than committing several
 * megabytes of ICS to git history.
 *
 * The mix is deliberately unkind and roughly mirrors a real household that has
 * subscribed to too many things: mostly one-off timed events, a solid minority
 * of recurring series that each expand to many instances, all-day spans, a
 * handful of overrides, and four different source timezones so the zone
 * resolver cannot cache its way to a flattering number.
 */

const ZONES = ['America/Chicago', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney'];

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function stamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}00`
  );
}

function dateStamp(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
}

export interface LargeFeedOptions {
  /** Number of VEVENT components to emit. */
  readonly eventCount: number;
  /** First day the feed covers. */
  readonly start?: Date;
}

export function generateLargeFeed(options: LargeFeedOptions): string {
  const { eventCount, start = new Date(Date.UTC(2026, 0, 1, 9, 0)) } = options;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Maverick Wall//Generated Load Fixture//EN',
    'X-WR-CALNAME:Generated load fixture',
  ];

  for (let i = 0; i < eventCount; i++) {
    const zone = ZONES[i % ZONES.length]!;
    const dayOffset = i % 330;
    const begin = new Date(start.getTime() + dayOffset * 86_400_000 + (i % 9) * 3_600_000);
    const finish = new Date(begin.getTime() + 3_600_000);
    const uid = `load-${i}@generated`;

    lines.push('BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:Generated event ${i}`);

    if (i % 11 === 0) {
      // All-day, sometimes spanning several days.
      const span = 1 + (i % 4);
      const endDate = new Date(begin.getTime() + span * 86_400_000);
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(begin)}`, `DTEND;VALUE=DATE:${dateStamp(endDate)}`);
    } else {
      lines.push(
        `DTSTART;TZID=${zone}:${stamp(begin)}`,
        `DTEND;TZID=${zone}:${stamp(finish)}`,
        `LOCATION:Room ${i % 40}`,
      );
    }

    // Roughly one event in seven recurs, each expanding to many instances.
    if (i % 7 === 0) {
      lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${['MO', 'TU', 'WE', 'TH', 'FR'][i % 5]};COUNT=30`);
      if (i % 21 === 0) {
        lines.push(`EXDATE;TZID=${zone}:${stamp(new Date(begin.getTime() + 7 * 86_400_000))}`);
      }
    }

    lines.push('END:VEVENT');

    // A few RECURRENCE-ID overrides, since those exercise the slowest path.
    if (i % 97 === 0 && i % 7 === 0) {
      const moved = new Date(begin.getTime() + 14 * 86_400_000);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `SUMMARY:Generated event ${i} (moved)`,
        `RECURRENCE-ID;TZID=${zone}:${stamp(moved)}`,
        `DTSTART;TZID=${zone}:${stamp(new Date(moved.getTime() + 5_400_000))}`,
        `DTEND;TZID=${zone}:${stamp(new Date(moved.getTime() + 9_000_000))}`,
        'SEQUENCE:1',
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}
