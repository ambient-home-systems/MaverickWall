import { describe, expect, it } from 'vitest';
import { redactLogText, redactLog, looksLikeSecret, REDACTED } from '../src/api/redact.js';
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

  it('takes a real token out of the real lines this server prints', () => {
    /*
     * The assertion that can honestly be made at 100%, and the one that is
     * actually the security property.
     *
     * This used to be `looksLikeSecret(issueSetupToken().token)` fifty times
     * over, which asserted something the rule has never done and does not
     * claim to: the entropy heuristic is a *backstop*, and its own docstring
     * has always quoted a miss rate. About one CI run in five went red on it,
     * and the fix for that is not a looser assertion — it is asking the
     * question the export actually turns on. Everything this codebase prints a
     * credential in, it prints *labelled* — `?token=`, `enter this code:` —
     * and the labelled rules take those apart deterministically, whatever the
     * random bytes happen to be.
     *
     * So: real generated tokens, in the real boot lines, through the real
     * `redactLogText`. Two hundred of each, and the token must not survive in
     * any form.
     */
    for (let i = 0; i < 200; i++) {
      const setup = issueSetupToken();
      const display = issueDisplayToken().token;
      const lines = [
        `    http://192.168.1.10:8080/setup?token=${setup.token}`,
        `  Or go to http://192.168.1.10:8080/setup and enter this code:  ${setup.shortCode}`,
        `    http://<this-host>:8080/pair?token=${display}`,
        `{"token":"${display}"}`,
      ];
      for (const line of lines) {
        const redacted = redactLogText(line);
        expect(redacted, `left the credential in: ${line}`).not.toContain(setup.token);
        expect(redacted).not.toContain(display);
        expect(redacted).toContain(REDACTED);
      }
      // The short code is eight characters, far under the entropy rule's floor,
      // so it lives or dies entirely by its label.
      expect(redactLogText(lines[1] as string)).not.toContain(setup.shortCode);
    }
  });

  it('reads an unlabelled token as a secret, and a long identifier as a name', () => {
    /*
     * The backstop, stated as the bar it actually clears.
     *
     * Each literal below is a *real* token from `issueSetupToken`, kept because
     * it escaped the rule before the vowel-density clause went in. They are the
     * regression cases: revert that clause and these turn red at once, which a
     * rate over random tokens could never promise to do.
     */
    for (const escaped of [
      'OmbkvhZhurRVOedzMLOZcPckUcw_5JiN',
      'ZJwynURyldafuBmWkgwULQCMsTCubcLh',
      '9i_DjmtzoglKHhcJyagIwvaDBLAQnTH8',
      'rcoPXTGLCuJLRbpVWLgEH6-ak_Wxnhe7',
      'XUhHXrUpjNnJZUllwBYOJb',
    ]) {
      expect(looksLikeSecret(escaped), `${escaped} would survive the export`).toBe(true);
    }

    /*
     * And a floor on the general case, sampled wide enough that the randomness
     * cannot decide it. Measured, the rule catches about 1,817 of every 1,818
     * tokens its generators produce; at four thousand draws, a run that fell
     * below 99% would be a broken rule rather than a bad afternoon.
     */
    const draws = 4000;
    let caught = 0;
    for (let i = 0; i < draws; i++) {
      if (looksLikeSecret(issueSetupToken().token)) caught++;
      if (looksLikeSecret(issueDisplayToken().token)) caught++;
    }
    expect(caught / (draws * 2)).toBeGreaterThan(0.99);

    /*
     * The other direction, which is the one that decides whether the export is
     * worth attaching. `MaverickWallDisplayEditor` and
     * `AndroidTVWebViewKioskShell` are here because every length-based fix for
     * the miss rate above redacts them — the measurement that ruled those out.
     */
    for (const name of [
      'SQLITE_CONSTRAINT_PRIMARYKEY',
      'application_x_www_form_urlencoded',
      'MaverickWallDisplayEditor',
      'AndroidTVWebViewKioskShell',
      'homeassistant_calendar_source',
      'x86_64-unknown-linux-gnu',
      'brotliDecompressSync',
      'calendar_events_cache',
    ]) {
      expect(looksLikeSecret(name), `${name} would be redacted out of the export`).toBe(false);
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
