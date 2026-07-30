import { analyseTitles, type TitleObservation } from '@maverick-wall/core';
import { openAndMigrate } from '../db/bootstrap.js';

/**
 * Show which event titles in a feed look like shift markers.
 *
 * The data behind what will become a settings screen. The point is that nobody
 * should have to describe their shifts in the abstract — asking gets you
 * guesses, whereas listing what is genuinely in the calendar and asking which
 * ones are work gets you the truth, including the variants a real feed contains
 * that no amount of careful typing would have produced.
 *
 *   node dist/tools/analyse-titles.js [source-id]
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';
const { db, dataDir: resolved } = openAndMigrate(dataDir);
console.log(`Using ${resolved}`);
console.log('');

const household = db
  .prepare("SELECT timezone FROM household_settings WHERE id = 'singleton'")
  .get() as { timezone: string } | undefined;
const timezone = household?.timezone ?? 'UTC';

/** Local `HH:MM`, so start-time variance can be measured. */
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone,
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});

const wanted = process.argv[2];
const sources = db
  .prepare(`SELECT id, name FROM calendar_sources ${wanted ? 'WHERE id = ?' : ''} ORDER BY name`)
  .all(...(wanted ? [wanted] : [])) as { id: string; name: string }[];

if (sources.length === 0) {
  console.error(wanted ? `No source with id ${wanted}.` : 'No calendar sources configured.');
  process.exit(1);
}

for (const source of sources) {
  const rows = db
    .prepare(
      `SELECT title, all_day AS allDay, starts_at AS startsAt,
              start_local_date AS startDate, end_local_date AS endDate
         FROM calendar_events_cache WHERE source_id = ?`,
    )
    .all(source.id) as {
    title: string;
    allDay: number;
    startsAt: number;
    startDate: string;
    endDate: string;
  }[];

  console.log(`── ${source.name} — ${rows.length} cached events ${'─'.repeat(20)}`);

  if (rows.length === 0) {
    console.log('  Nothing cached yet. Let a sync run first.');
    console.log('');
    continue;
  }

  const observations: TitleObservation[] = rows.map((row) => {
    // Every local date the event touches, so a multi-day block counts as one.
    const dates: string[] = [];
    let cursor = row.startDate;
    let guard = 0;
    while (cursor <= row.endDate && guard++ < 400) {
      dates.push(cursor);
      const next = new Date(`${cursor}T00:00:00Z`).getTime() + 86_400_000;
      cursor = new Date(next).toISOString().slice(0, 10);
    }
    return row.allDay === 1
      ? { title: row.title, dates, allDay: true }
      : {
          title: row.title,
          dates,
          allDay: false,
          // A shift moves around the clock; a standing appointment does not.
          startTime: clock.format(new Date(row.startsAt)),
        };
  });

  const allDates = new Set(observations.flatMap((observation) => observation.dates));
  const sorted = [...allDates].sort();
  const windowDays =
    sorted.length < 2
      ? 1
      : Math.round(
          (Date.parse(`${sorted[sorted.length - 1]!}T00:00:00Z`) -
            Date.parse(`${sorted[0]!}T00:00:00Z`)) /
            86_400_000,
        ) + 1;

  const candidates = analyseTitles({ observations, windowDays });
  const likely = candidates.filter((candidate) => candidate.confidence === 'likely');
  const possible = candidates.filter((candidate) => candidate.confidence === 'possible');
  const unlikely = candidates.filter((candidate) => candidate.confidence === 'unlikely');

  console.log(`  ${windowDays} days of data, ${candidates.length} distinct titles`);
  console.log('');

  const describe = (candidate: (typeof candidates)[number]): void => {
    const suggestion =
      candidate.suggestedShiftKey === undefined
        ? '?'
        : candidate.suggestedShiftKey === null
          ? 'off'
          : candidate.suggestedShiftKey;
    const kind = candidate.allDay ? 'all-day' : `${candidate.distinctStartTimes} start time(s)`;
    console.log(`    [${suggestion.padEnd(8)}] ${candidate.title}`);
    console.log(`                 ${kind}; ${candidate.reason}`);
  };

  if (likely.length > 0) {
    console.log('  Almost certainly a work schedule:');
    console.log('');
    for (const candidate of likely) describe(candidate);
    console.log('');
  }

  if (possible.length > 0) {
    // The tier that exists because a fixed weekly shift and a weekly class look
    // identical from here. Offering both and asking beats guessing.
    console.log('  Could be a work schedule — only you can say:');
    console.log('');
    for (const candidate of possible) describe(candidate);
    console.log('');
  }

  if (likely.length === 0 && possible.length === 0) {
    console.log('  Nothing here looks like a work schedule.');
    console.log('');
  }

  if (unlikely.length > 0) {
    console.log('  Ordinary events:');
    for (const candidate of unlikely.slice(0, 8)) {
      console.log(`    ${String(candidate.occurrences).padStart(3)}×  ${candidate.title.slice(0, 44)}`);
    }
    if (unlikely.length > 8) console.log(`    … and ${unlikely.length - 8} more`);
  }

  console.log('');
  console.log('  A settings screen will let you confirm each of these. Anything you');
  console.log("  confirm becomes the day's colour and drops out of the agenda, so a");
  console.log('  feed that marks every day does not bury the appointments.');
  console.log('');
}

db.close();
