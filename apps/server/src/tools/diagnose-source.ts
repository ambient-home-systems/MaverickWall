import { expandCalendar } from '@maverick-wall/calendar';
import { FETCH_LIMITS } from '@maverick-wall/core';
import { openAndMigrate } from '../db/bootstrap.js';
import { createKeyring, loadOrCreateMasterKey } from '../secrets/keyring.js';
import { createFetcher } from '../net/fetcher.js';

/**
 * Fetch a calendar source and report what actually came back.
 *
 * Exists because "PARSE_FAILED" is not a diagnosis. The manifest deliberately
 * carries only messages safe to show on a kitchen wall, which means the
 * parser's own detail — the thing that says *what* was wrong on *which line* —
 * never reaches anybody. This prints it.
 *
 *   node dist/tools/diagnose-source.js [source-id]
 *
 * The feed URL is never printed. Only its host, the response shape, and the
 * first few lines of the body, which for a calendar are structural rather than
 * personal.
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';
const { db, dataDir: resolved } = openAndMigrate(dataDir);
console.log(`Using ${resolved}`);
console.log('');

interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly urlEncrypted: string;
  readonly allowPrivateNetwork: number;
  readonly allowLoopback: number;
  readonly allowHttp: number;
}

const wanted = process.argv[2];
const sources = db
  .prepare(
    `SELECT id, name, url_encrypted AS urlEncrypted,
            allow_private_network AS allowPrivateNetwork,
            allow_loopback AS allowLoopback, allow_http AS allowHttp
       FROM calendar_sources ${wanted ? 'WHERE id = ?' : ''}`,
  )
  .all(...(wanted ? [wanted] : [])) as SourceRow[];

if (sources.length === 0) {
  console.error(wanted ? `No source with id ${wanted}.` : 'No calendar sources configured.');
  process.exit(1);
}

const master = loadOrCreateMasterKey(dataDir);
if (master.unusableKeyWarning) {
  // This tool's whole purpose is surfacing the real cause of a feed
  // failure; a silently regenerated key would hide exactly this one — every
  // source above would decrypt to garbage and report as unreadable for a
  // reason the operator was never told.
  console.error(`Warning: ${master.unusableKeyWarning}`);
  console.error('');
}
const keyring = createKeyring(master.key);
const fetcher = createFetcher();

for (const source of sources) {
  console.log(`── ${source.name} (${source.id}) ${'─'.repeat(Math.max(0, 40 - source.name.length))}`);

  const opened = keyring.decrypt(source.urlEncrypted, 'calendar-source-url');
  if (!opened.ok) {
    console.log(`  URL could not be decrypted: ${opened.reason}`);
    console.log('  The address needs entering again.');
    continue;
  }

  let host = '(unparseable)';
  try {
    host = new URL(opened.value).hostname;
  } catch {
    /* reported below */
  }
  console.log(`  host:        ${host}`);
  console.log(`  path length: ${opened.value.length} characters`);
  console.log(
    `  policy:      lan=${source.allowPrivateNetwork === 1} ` +
      `loopback=${source.allowLoopback === 1} http=${source.allowHttp === 1}`,
  );

  const response = await fetcher.fetch({
    url: opened.value,
    policy: {
      allowPrivateNetwork: source.allowPrivateNetwork === 1,
      allowLoopback: source.allowLoopback === 1,
      allowHttp: source.allowHttp === 1,
    },
    maxBytes: FETCH_LIMITS.ics,
    acceptContentTypes: ['text/calendar', 'application/octet-stream', 'text/plain'],
  });

  console.log(`  fetch:       ${response.status}`);

  if (response.status === 'rejected' || response.status === 'failed') {
    console.log(`  code:        ${response.code}`);
    console.log(`  message:     ${response.message}`);
    if (response.status === 'failed' && response.httpStatus !== undefined) {
      console.log(`  http status: ${response.httpStatus}`);
    }
    continue;
  }

  if (response.status === 'not-modified') {
    console.log('  The server says nothing has changed. Clear the stored ETag to force a fetch.');
    continue;
  }

  console.log(`  content-type: ${response.contentType}`);
  console.log(`  bytes:        ${response.byteSize.toLocaleString()}`);
  console.log(`  final url:    ${new URL(response.finalUrl).hostname}${new URL(response.finalUrl).pathname.slice(0, 24)}…`);
  console.log('');
  console.log('  first four lines of the body:');
  for (const line of response.body.split(/\r?\n/).slice(0, 4)) {
    console.log(`    │ ${line.slice(0, 100)}`);
  }
  console.log('');

  // A feed that is not ICS at all is the commonest cause, and the first line
  // says so immediately.
  if (!response.body.trimStart().startsWith('BEGIN:VCALENDAR')) {
    console.log('  This does not start with BEGIN:VCALENDAR, so it is not an iCalendar feed.');
    console.log('  Check the URL is the "secret address in iCal format" rather than a web page.');
    console.log('');
  }

  const expanded = expandCalendar({
    icsText: response.body,
    targetTimezone: 'America/New_York',
    windowStart: new Date(Date.now() - 7 * 86_400_000),
    windowEnd: new Date(Date.now() + 90 * 86_400_000),
    maxEvents: 5000,
  });

  if (!expanded.ok) {
    console.log(`  parse:       FAILED (${expanded.error.code})`);
    console.log(`  message:     ${expanded.error.message}`);
    // The part the manifest never showed, and the only line that says what the
    // parser actually objected to.
    if (expanded.error.detail) console.log(`  detail:      ${expanded.error.detail}`);
  } else {
    console.log(`  parse:       ok, ${expanded.value.length} events in the window`);
    if (expanded.meta.warnings.length > 0) {
      console.log('  warnings:');
      for (const warning of expanded.meta.warnings.slice(0, 5)) {
        console.log(`    ${warning.code}: ${warning.message}`);
      }
    }
    for (const event of expanded.value.slice(0, 3)) {
      console.log(`    ${event.startUtc.toISOString()}  ${event.title.slice(0, 40)}`);
    }
  }
  console.log('');
}

db.close();
