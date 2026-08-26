import { describe, expect, it } from 'vitest';
import { redactLogText, redactLog, looksLikeSecret } from '../src/api/redact.js';
import { issueDisplayToken, issueSetupToken } from '../src/auth/tokens.js';

/*
 * Both directions, and the second one is the one that decides whether this
 * feature is any good. An export stripped of hosts, paths, error codes and
 * versions is an export nobody attaches, and then rule eleven — somebody has
 * to be able to diagnose this without anyone reaching their machine — is worse
 * off than it was with the credentials left in.
 *
 * The corpus below is not invented. Every line in it is a `console.log` that
 * exists in `apps/server/src`, read off the source.
 */

describe('redacting the diagnostics log tail', () => {
  it('takes the credential out of every line that carries one', () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        '    http://192.168.1.10:8080/setup?token=PqCFLGD7amZLFPff-B5xsY3mqOMbzoqT',
        '    http://192.168.1.10:8080/setup?token=[redacted]',
      ],
      [
        '  Or go to http://192.168.1.10:8080/setup and enter this code:  AHHZEKJQ',
        '  Or go to http://192.168.1.10:8080/setup and enter this code:  [redacted]',
      ],
      [
        '    http://<this-host>:8080/pair?token=hQ2rT8vLmN4pXsA1bC3dE5fG7hJ9kL0m',
        '    http://<this-host>:8080/pair?token=[redacted]',
      ],
      ['  Or enter code:  ACDE-FGHJ', '  Or enter code:  [redacted]'],
      // The value runs to the closing quote, so the shape of the command a
      // household was told to run still reads as a command.
      [
        '    curl -H "Authorization: Bearer hQ2rT8vLmN4pXsA1bC3dE5fG7hJ9kL0m" \\',
        '    curl -H "Authorization: [redacted]" \\',
      ],
      // A cookie leaks from its third field, so the whole value goes.
      [
        'cookie: theme=board; better-auth.session_token=aB3dE5fG7hJ9kL0mNoPqRsTu',
        'cookie: [redacted]',
      ],
      // The logger JSON-encodes anything that is not a string or an Error.
      ['{"apiKey":"sk-live-9f86d081884c7d659a2feaa0c55ad015"}', '{"apiKey":"[redacted]"}'],
      // Two rules reach this line. The second must not redact the first's
      // marker: `[redacted]]` reads as a value with a bracket in it.
      ['x-api-key: sk_live_abc123def456', 'x-api-key: [redacted]'],
      // A value stops where the query string does, so the host beside it lives.
      [
        'GET /d/manifest?token=hQ2rT8vLmN4p&code=ACDEFGHJ from calendar.google.com',
        'GET /d/manifest?token=[redacted]&code=[redacted] from calendar.google.com',
      ],
      // A scheme with no header name in front of it, which the header rule
      // above never sees.
      [
        '[job] ha-sync: refused, sent Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
        '[job] ha-sync: refused, sent Bearer [redacted]',
      ],
      // Unlabelled, which is the case the entropy rule exists for.
      [
        '[http] token hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 unknown',
        '[http] token hash [redacted] unknown',
      ],
    ];
    for (const [line, expected] of cases) expect(redactLogText(line)).toBe(expected);
  });

  it('leaves everything a bug report is actually written from', () => {
    // Hostnames, addresses, ports, paths, error codes, job kinds, ids and
    // versions. Each of these is a line this server really writes.
    const kept = [
      '[boot] listening on http://0.0.0.0:8080',
      '[boot] database /data/maverick.db',
      '[boot] data directory /Users/joshuawolfemallow/Documents/maverick_wall/maverick-wall/data',
      '[boot] display bundle /app/apps/display/dist',
      '[boot] scheduler started, timezone Europe/London',
      '[boot] detected wall address http://192.168.1.10:8080',
      '[boot] restored a database backup; the previous one is at /data/maverick-2026-08-26T09-00-00-000Z.db',
      '[boot] generated a new encryption key',
      '[ingress] first request from 172.30.32.2; trusted supervisor source: yes',
      '[job] ics-sync: calendar.google.com did not resolve.',
      '[job] weather-nws: The server answered 503.',
      '[http] SQLITE_BUSY_SNAPSHOT while reading calendar_events_cache',
      '[manifest] build failed: no such column: layout_follows',
      'ics-sync failed for p12-calendar-webhook.googleusercontent.com',
      '[boot] source a3f9c1d40b2e5f68 synced, 166 events, 0 warnings',
      'PARSE_FAILED: This does not start with BEGIN:VCALENDAR',
      '[shutdown] SIGTERM',
      'appVersion 0.54.2-rc1+build.20260826',
    ];
    for (const line of kept) expect(redactLogText(line)).toBe(line);
  });

  it('reads a real token as a secret and a long identifier as a name', () => {
    // The generators rather than invented bytes: what has to be caught is
    // whatever base64url actually produces, not what a person would type as an
    // example of it.
    for (let i = 0; i < 50; i++) {
      expect(looksLikeSecret(issueSetupToken().token)).toBe(true);
      expect(looksLikeSecret(issueDisplayToken().token)).toBe(true);
    }
    for (const name of [
      'SQLITE_CONSTRAINT_PRIMARYKEY',
      'application_x_www_form_urlencoded',
      'MaverickWallDisplayEditor',
      'homeassistant_calendar_source',
      'x86_64-unknown-linux-gnu',
    ]) {
      expect(looksLikeSecret(name)).toBe(false);
    }
  });

  it('keeps the timestamp and the level of every line it rewrites', () => {
    // A redacted tail is still a log: the ordering and the levels are half of
    // what somebody reads it for.
    // The redacted line is the `error`, deliberately: with the levels the
    // other way round this passed just as happily while `redactLog` rebuilt
    // every line as `info`, because the only line it rebuilt was already one.
    const lines = [
      { at: 1, level: 'error' as const, text: 'a?token=hQ2rT8vLmN4pXsA1bC3dE5fG7hJ9kL0m' },
      { at: 2, level: 'info' as const, text: '[job] ics-sync: failed' },
    ];
    const out = redactLog(lines);
    expect(out.map((line) => [line.at, line.level])).toEqual([
      [1, 'error'],
      [2, 'info'],
    ]);
    expect(out[0]?.text).toBe('a?token=[redacted]');
    expect(out[1]?.text).toBe('[job] ics-sync: failed');
  });
});
