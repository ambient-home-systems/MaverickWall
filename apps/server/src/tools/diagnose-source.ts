import { expandCalendar } from '@maverick-wall/calendar';
import { FETCH_LIMITS } from '@maverick-wall/core';
import { openAndMigrate } from '../db/bootstrap.js';
import { createKeyring, loadOrCreateMasterKey } from '../secrets/keyring.js';
import { createFetcher } from '../net/fetcher.js';
import { connectionFor } from '../api/feed-credentials.js';
import { accountForSource } from '../api/caldav-accounts.js';
import { CTAG_BODY } from '../caldav/query.js';
import { CALENDARSERVER_NS, prop, readMultistatus } from '../caldav/multistatus.js';

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
 * The feed URL is never printed, and neither is a feed's password. Only the
 * host, the account it signs in as, the response shape, and the first few
 * lines of the body, which for a calendar are structural rather than personal.
 * A password stored against a source is reported as the words "password
 * stored" and nothing else — the same rule `lastError` follows.
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';
const { db, dataDir: resolved } = openAndMigrate(dataDir);
console.log(`Using ${resolved}`);
console.log('');

interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly urlEncrypted: string;
  readonly etag: string | null;
  readonly allowPrivateNetwork: number;
  readonly allowLoopback: number;
  readonly allowHttp: number;
  readonly authUsername: string | null;
  readonly authPasswordEncrypted: string | null;
  readonly caldavAccountId: string | null;
}

const wanted = process.argv[2];
const sources = db
  .prepare(
    `SELECT id, name, kind, url_encrypted AS urlEncrypted, etag,
            allow_private_network AS allowPrivateNetwork,
            allow_loopback AS allowLoopback, allow_http AS allowHttp,
            auth_username AS authUsername,
            auth_password_encrypted AS authPasswordEncrypted,
            caldav_account_id AS caldavAccountId
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

  /*
   * The account, when this calendar is reached through one (RFC 013 §6.2.1).
   *
   * Read *before* `connectionFor`, because it is what that function reads
   * first: printing the row's own columns for a CalDAV calendar would describe
   * a connection this server never makes, which is precisely the "one meaning,
   * two places" fault §6.2.2 exists to prevent, in the tool somebody points at
   * a calendar that is not working.
   */
  const account = accountForSource(db, source.caldavAccountId);

  // The same resolver the sync job uses, so what this tool exercises is the
  // connection the sync will actually make rather than a second opinion of it.
  const connection = connectionFor(
    {
      url: opened.value,
      allowPrivateNetwork: source.allowPrivateNetwork === 1,
      allowLoopback: source.allowLoopback === 1,
      allowHttp: source.allowHttp === 1,
      authUsername: source.authUsername,
      authPassword: { stored: source.authPasswordEncrypted },
      ...(account === undefined ? {} : { account }),
    },
    keyring,
  );

  /*
   * The **resolved** policy, printed after the resolver rather than off the
   * row.
   *
   * For a CalDAV calendar the three switches live on the account (§6.2.1), so
   * the calendar's own columns are always false — and this line printed them,
   * which had a healthy calendar reporting `http=false` directly above a
   * `PROPFIND` that had just succeeded over plain http. That is §6.2.2's "one
   * meaning, two places" arriving in the one tool whose whole job is to say
   * what the sync is actually doing. Found by running it against a real server
   * and reading the output, which is the only way this kind of wrong is ever
   * visible.
   */
  console.log(
    `  policy:      lan=${connection.policy.allowPrivateNetwork === true} ` +
      `loopback=${connection.policy.allowLoopback === true} ` +
      `http=${connection.policy.allowHttp === true}` +
      (source.caldavAccountId === null ? '' : ' (from the CalDAV account)'),
  );

  if (source.kind === 'caldav') {
    /*
     * What a CalDAV calendar's diagnosis needs that an ICS feed's does not.
     *
     * The **account** because one credential reaches several calendars, so
     * "which of my calendars stopped" is answered by knowing they share one.
     * The **confirmed host** because it is the only record of the decision
     * §6.3.1 asked the household to make, and a calendar failing after Apple
     * moved an account to a new partition host looks like a wrong password
     * from every other angle. The **CTag** because an unchanged one is why a
     * sync did no work, and a household staring at "synced 2 minutes ago" with
     * yesterday's events needs to be told the server said nothing had changed.
     */
    console.log(`  kind:        CalDAV collection`);
    console.log(`  account:     ${account === undefined ? '(missing — the account row is gone)' : account.username}`);
    console.log(
      `  host policy: ${
        account?.confirmedHost == null
          ? 'discovery stayed on the address that was typed'
          : `confirmed ${account.confirmedHost}`
      }`,
    );
    console.log(`  CTag:        ${source.etag ?? '(none stored — the next sync will fetch everything)'}`);

    /*
     * And the probe is the one the sync actually makes, not a GET.
     *
     * A `GET` with ICS content types against a collection href is answered with
     * a 405 or an HTML listing by every CalDAV server there is — so running the
     * ICS path here would report a perfectly healthy calendar as failing, which
     * is the exact false diagnosis this tool exists to remove. The CTag
     * `PROPFIND` is what the sync sends every fifteen minutes, so what this
     * prints is what is actually happening.
     */
    const probe = await fetcher.fetch({
      url: connection.url,
      policy: connection.policy,
      method: 'PROPFIND',
      body: CTAG_BODY,
      maxBytes: FETCH_LIMITS.dav,
      acceptContentTypes: ['application/xml', 'text/xml'],
      headers: { ...connection.headers, depth: '0' },
    });

    console.log(`  PROPFIND:    ${probe.status}`);
    if (probe.status === 'rejected' || probe.status === 'failed') {
      console.log(`  code:        ${probe.code}`);
      console.log(`  message:     ${probe.message}`);
      if (probe.status === 'failed' && probe.httpStatus !== undefined) {
        console.log(`  http status: ${probe.httpStatus}`);
        if (probe.httpStatus === 401 || probe.httpStatus === 403) {
          console.log('  The password was refused. It is one password for every calendar on this');
          console.log('  account, so the others will be failing too — change it once.');
        }
      }
      console.log('');
      continue;
    }
    if (probe.status === 'ok') {
      const live = ctagOf(probe.body);
      console.log(`  server CTag: ${live ?? '(the server sent none — every sync fetches everything)'}`);
      if (live !== undefined && source.etag !== null) {
        if (live === source.etag) {
          console.log('  Unchanged since the last sync, so the next one will do no work.');
          console.log('  If the wall is showing stale events, the server is saying nothing');
          console.log('  has changed — the fault is upstream rather than here.');
        } else {
          console.log('  Changed since the last sync, so the next one will fetch it again.');
        }
      }
    }
    console.log('');
    continue;
  }

  /*
   * The account, and never the password.
   *
   * The username is already on the settings row, so printing it costs nothing
   * and is often the whole diagnosis — a feed signing in as the wrong account
   * looks identical to one signing in with the wrong password. The password
   * itself crosses this codebase exactly as far as the keyring and the
   * outbound header, and a terminal somebody is about to paste into an issue
   * is neither.
   */
  console.log(`  signs in as: ${source.authUsername ?? '(nobody)'}`);
  console.log(
    `  password:    ${
      source.authPasswordEncrypted === null
        ? 'none stored'
        : connection.passwordUnreadable
          ? 'stored, but it could not be decrypted — it needs entering again'
          : 'password stored'
    }`,
  );
  if (source.authUsername !== null && connection.headers['authorization'] === undefined) {
    // Half a credential is not a credential: `connectionFor` sends nothing, and
    // a household looking at a 401 would otherwise have no way to see that.
    console.log('  note:        no sign-in header was sent — a username needs a password beside it');
  }

  const response = await fetcher.fetch({
    url: connection.url,
    policy: connection.policy,
    maxBytes: FETCH_LIMITS.ics,
    acceptContentTypes: ['text/calendar', 'application/octet-stream', 'text/plain'],
    ...(Object.keys(connection.headers).length > 0 ? { headers: connection.headers } : {}),
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

/** `CS:getctag` off a `PROPFIND` answer, or undefined when the server sends none. */
function ctagOf(xml: string): string | undefined {
  const document = readMultistatus(xml);
  if (!document.ok) return undefined;
  for (const response of document.responses) {
    const value = prop(response, CALENDARSERVER_NS, 'getctag')?.text;
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}
