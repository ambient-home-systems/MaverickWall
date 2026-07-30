import { DEFAULT_SHIFT_MATCHERS, presetByKey, buildRotationCycle } from '@maverick-wall/core';
import { randomBytes } from 'node:crypto';
import { openAndMigrate } from '../db/bootstrap.js';

/**
 * Turn on the shift feature.
 *
 *   node dist/tools/enable-shift.js --from-calendar <source-id>
 *   node dist/tools/enable-shift.js --pattern <anchor-date>
 *   node dist/tools/enable-shift.js --off
 *
 * Two ways to know what shift somebody is on. Deriving it from a calendar the
 * employer already publishes is the more reliable of the two, because it
 * follows swaps and roster changes without anybody editing anything. A pattern
 * is the fallback for people whose shifts are not in a calendar at all.
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';
const { db, dataDir: resolved } = openAndMigrate(dataDir);
console.log(`Using ${resolved}`);
console.log('');

const argv = process.argv.slice(2);
const mode = argv[0];
const now = Date.now();

/** `--person Name`, defaulting to a single household member. */
function personName(): string {
  const index = argv.indexOf('--person');
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : 'Me';
}

/**
 * Find or create the person a plan belongs to.
 *
 * Plans are per person because households have more than one shift worker, and
 * a rota with no owner cannot be displayed alongside another one.
 */
function ensurePerson(name: string): { id: string; name: string } {
  const existing = db.prepare('SELECT id, name FROM people WHERE name = ?').get(name) as
    | { id: string; name: string }
    | undefined;
  if (existing) {
    db.prepare('UPDATE people SET has_shift_rotation = 1, updated_at = ? WHERE id = ?').run(now, existing.id);
    return existing;
  }
  const id = randomBytes(6).toString('hex');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n;
  const palette = ['#E8A33D', '#4C7FD1', '#6FB07F', '#B3372B'];
  db.prepare(
    `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, name, palette[count % palette.length], count, now, now);
  console.log(`Created "${name}".`);
  return { id, name };
}

function setEnabled(enabled: boolean): void {
  db.prepare('UPDATE household_settings SET shift_enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    now,
    'singleton',
  );
}

if (mode === '--off') {
  setEnabled(false);
  console.log('Shift display turned off. Plans are kept, so turning it back on restores them.');
  db.close();
  process.exit(0);
}

if (mode === '--from-calendar') {
  const sourceId = argv[1];
  if (!sourceId) {
    console.error('usage: enable-shift --from-calendar <source-id>');
    console.error('  (run diagnose-source to list source ids)');
    process.exit(1);
  }

  const source = db.prepare('SELECT id, name FROM calendar_sources WHERE id = ?').get(sourceId) as
    | { id: string; name: string }
    | undefined;
  if (!source) {
    console.error(`No calendar source with id ${sourceId}.`);
    process.exit(1);
  }

  const person = ensurePerson(personName());
  // Replaces only this person's calendar plan, so a second person's stays put.
  db.prepare('DELETE FROM shift_plans WHERE kind = ? AND person_id = ?').run('calendar', person.id);
  db.prepare(
    `INSERT INTO shift_plans
       (id, name, kind, person_id, effective_from, effective_to, priority,
        calendar_source_id, matchers, consumes_events, created_at, updated_at)
     VALUES (?, ?, 'calendar', ?, '2000-01-01', NULL, 10, ?, ?, 1, ?, ?)`,
  ).run(
    randomBytes(8).toString('hex'),
    `${person.name} from ${source.name}`,
    person.id,
    sourceId,
    JSON.stringify(DEFAULT_SHIFT_MATCHERS),
    now,
    now,
  );
  setEnabled(true);

  console.log(`${person.name}'s shifts will be read from "${source.name}".`);
  console.log('');
  console.log('  Titles are matched in this order, first match winning:');
  for (const matcher of DEFAULT_SHIFT_MATCHERS) {
    const target = matcher.shiftTypeKey ?? 'not working';
    console.log(`    "${matcher.pattern}"${' '.repeat(Math.max(1, 14 - matcher.pattern.length))}→ ${target}`);
  }
  console.log('');
  console.log('  Matched events become the day\'s colour and drop out of the agenda,');
  console.log('  so a feed that marks every day does not bury the appointments.');
  db.close();
  process.exit(0);
}

if (mode === '--pattern') {
  const anchor = argv[1];
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    console.error('usage: enable-shift --pattern YYYY-MM-DD');
    console.error('  The date is day one of a cycle: the Sunday a Days fortnight begins.');
    process.exit(1);
  }

  const preset = presetByKey('ten-week-federal');
  if (!preset) {
    console.error('The ten-week preset is missing.');
    process.exit(1);
  }
  const cycle = buildRotationCycle({ blocks: preset.blocks, anchorDate: anchor });

  const person = ensurePerson(personName());
  db.prepare('DELETE FROM shift_plans WHERE kind = ? AND person_id = ?').run('pattern', person.id);
  db.prepare(
    `INSERT INTO shift_plans
       (id, name, kind, person_id, effective_from, effective_to, priority,
        anchor_date, cycle, consumes_events, created_at, updated_at)
     VALUES (?, ?, 'pattern', ?, '2000-01-01', NULL, 0, ?, ?, 0, ?, ?)`,
  ).run(
    randomBytes(8).toString('hex'), `${person.name}: ${preset.name}`, person.id,
    anchor, JSON.stringify(cycle), now, now,
  );
  setEnabled(true);

  console.log(`${person.name}: ${preset.name}, anchored on ${anchor}.`);
  console.log(`  ${cycle.length} day cycle, ${cycle.filter((day) => day !== null).length} marked.`);
  console.log('');
  console.log('  A calendar plan, if one exists, takes precedence over this — so a');
  console.log('  swap published by the employer beats the pattern automatically.');
  db.close();
  process.exit(0);
}

console.error('usage: enable-shift --from-calendar <source-id> [--person Name]');
console.error('                    --pattern <YYYY-MM-DD>     [--person Name]');
console.error('                    --off');
console.error('');
console.error('  --person defaults to "Me". Give each shift worker their own name');
console.error('  and run it once per person.');
process.exit(1);
