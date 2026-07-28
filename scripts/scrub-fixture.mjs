#!/usr/bin/env node
//
// Anonymise a calendar feed in place, locally, before it becomes a fixture.
//
//   node scripts/scrub-fixture.mjs test/fixtures/real/my-calendar.ics
//
// The problem this solves: a real feed is the only way to test real producer
// behaviour, and a real feed is also somebody's private life. We want the
// former in the repository and none of the latter.
//
// The approach is character-class substitution rather than deletion. Letters
// become x, digits become 9, and everything else is preserved byte for byte:
// punctuation, whitespace, escape sequences, zero-width characters, emoji.
//
// That matters more than it sounds. Value lengths are preserved exactly, so
// RFC 5545 line folding lands on identical octet boundaries and the fixture
// still exercises the unfolding path the same way the original did. Deleting
// or summarising values would silently change the thing under test.
//
// Preserved verbatim, because they ARE the test:
//   UID, RRULE, EXDATE, RDATE, RECURRENCE-ID, DTSTART, DTEND, DURATION,
//   TZID parameters, VTIMEZONE blocks, SEQUENCE, STATUS, TRANSP, property
//   order, folding, CRLF line endings.
//
// Removed outright, because they are pure personal data with no structural
// interest: ATTENDEE, ORGANIZER, ATTACH, URL, and any X- property whose value
// looks like an address or a link.

import { readFileSync, writeFileSync } from 'node:fs';

/** Values replaced with same-length, same-shape placeholders. */
const OBFUSCATE = new Set([
  'SUMMARY',
  'DESCRIPTION',
  'LOCATION',
  'COMMENT',
  'CONTACT',
  'X-WR-CALNAME',
  'X-WR-CALDESC',
  'X-ALT-DESC',
]);

/** Properties dropped entirely, along with any folded continuation lines. */
const DROP = new Set(['ATTENDEE', 'ORGANIZER', 'ATTACH', 'URL', 'X-GOOGLE-CONFERENCE']);

/** Anything matching this in an X- property value gets the property dropped. */
const SENSITIVE_VALUE = /@|https?:\/\/|mailto:/i;

/**
 * Replace letters and digits, preserve everything else.
 *
 * Escape sequences are copied through as a unit. Without that, the `n` in `\n`
 * would become `x`, turning an escaped newline into the literal text `\x` and
 * quietly changing what the fixture tests.
 */
function obfuscate(value) {
  let out = '';
  const chars = [...value];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (ch === '\\' && i + 1 < chars.length) {
      out += ch + chars[i + 1];
      i++;
      continue;
    }

    if (/\p{Lu}/u.test(ch)) out += 'X';
    else if (/\p{Ll}/u.test(ch)) out += 'x';
    else if (/\p{N}/u.test(ch)) out += '9';
    else out += ch;
  }
  return out;
}

/** Split a content line at the colon separating name+params from value. */
function splitAtValue(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, null];
}

function propertyNameOf(line) {
  const [head] = splitAtValue(line);
  return (head.split(';')[0] ?? '').toUpperCase().trim();
}

function scrub(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  const stats = { obfuscated: 0, dropped: 0, preserved: 0 };

  // Tracks what the previous unfolded property was, so continuation lines get
  // the same treatment as the property they belong to.
  let mode = 'keep';

  for (const line of lines) {
    const isContinuation = line.startsWith(' ') || line.startsWith('\t');

    if (isContinuation) {
      if (mode === 'drop') {
        stats.dropped++;
        continue;
      }
      if (mode === 'obfuscate') {
        out.push(line[0] + obfuscate(line.slice(1)));
        continue;
      }
      out.push(line);
      continue;
    }

    const name = propertyNameOf(line);

    if (DROP.has(name)) {
      mode = 'drop';
      stats.dropped++;
      continue;
    }

    if (name.startsWith('X-')) {
      const [, value] = splitAtValue(line);
      if (value !== null && SENSITIVE_VALUE.test(value)) {
        mode = 'drop';
        stats.dropped++;
        continue;
      }
    }

    if (OBFUSCATE.has(name)) {
      const [head, value] = splitAtValue(line);
      if (value !== null) {
        mode = 'obfuscate';
        stats.obfuscated++;
        out.push(`${head}:${obfuscate(value)}`);
        continue;
      }
    }

    mode = 'keep';
    stats.preserved++;
    out.push(line);
  }

  return { text: out.join('\r\n'), stats };
}

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/scrub-fixture.mjs <path-to.ics>');
  process.exit(1);
}

const original = readFileSync(path, 'utf8');
const { text, stats } = scrub(original);
writeFileSync(path, text, 'utf8');

const count = (re) => (original.match(re) ?? []).length;

console.log(`Scrubbed ${path}`);
console.log(`  values obfuscated:  ${stats.obfuscated}`);
console.log(`  properties dropped: ${stats.dropped}`);
console.log(`  lines preserved:    ${stats.preserved}`);
console.log();
console.log('Structure preserved:');
console.log(`  VEVENT:        ${count(/^BEGIN:VEVENT/gm)}`);
console.log(`  RRULE:         ${count(/^RRULE/gm)}`);
console.log(`  RECURRENCE-ID: ${count(/^RECURRENCE-ID/gm)}`);
console.log(`  EXDATE:        ${count(/^EXDATE/gm)}`);
console.log(`  RDATE:         ${count(/^RDATE/gm)}`);
console.log(`  VTIMEZONE:     ${count(/^BEGIN:VTIMEZONE/gm)}`);
console.log();
console.log('Now verify before committing. This should print nothing:');
console.log(`  grep -iE '@|https?://|[A-Za-z]{4,}' ${path} | grep -vE '^(UID|DTSTART|DTEND|RRULE|EXDATE|RDATE|RECURRENCE-ID|TZID|BEGIN|END|PRODID|VERSION|CALSCALE|METHOD|DTSTAMP|CREATED|LAST-MODIFIED|SEQUENCE|STATUS|TRANSP|CLASS|X-)'`);
