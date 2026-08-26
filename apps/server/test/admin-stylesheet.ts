import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * The admin stylesheet as a page actually serves it, plus the crude parser the
 * design-system tests read it with.
 *
 * Both of those existed twice, byte-identical, in `admin-design-system.test.ts`
 * and `admin-button-states.test.ts` before RFC 009 Phase 6 wanted a third and a
 * fourth reader. Two copies of a parser is how two tests end up disagreeing
 * about what a rule is — which is the same drift the tests themselves exist to
 * catch — so it lives here, next to `browser-harness.ts`, and every reader gets
 * the same answer.
 *
 * The stylesheet is fetched rather than read off disk on purpose: it is
 * assembled at request time out of `design-tokens.ts` and several template
 * literals, so the served bytes are the only place the whole thing exists.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let cached: Promise<string> | undefined;

/**
 * The inline `<style>` block of a served admin page.
 *
 * Memoised for the process: booting a database and running thirty-odd
 * migrations to read a constant string, once per assertion, is most of a
 * suite's wall clock for no extra coverage. Sign-in is used because it is
 * served signed out and carries the whole sheet.
 */
export function adminStylesheet(): Promise<string> {
  cached ??= build();
  return cached;
}

async function build(): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-stylesheet-'));
  try {
    const { db } = openDatabase({ dataDir });
    try {
      runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
      const stamp = Date.now();
      db.prepare(
        `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
      ).run(stamp, stamp);
      // A distinct address per harness: the auth rate-limit counters are
      // module-global and outlive an instance, so a shared bucket would make
      // one test file's traffic another's 429.
      const octets = [...randomBytes(3)].join('.');
      const app = createApp({
        db,
        appVersion: '0.1.0-test',
        bootNotices: [],
        auth: { secret: 'b'.repeat(32), baseUrl: 'http://localhost' },
        keyring: createKeyring(randomBytes(32)),
        fetcher: createFetcher(),
        clientAddress: () => `10.${octets}`,
        setupToken: createSetupTokenHolder(() => {}),
        dataDir,
      });
      const html = await (await app.fetch(new Request('http://localhost/admin/sign-in'))).text();
      const opened = html.indexOf('<style>');
      const closed = html.indexOf('</style>', opened);
      if (opened < 0 || closed < 0) throw new Error('the admin page carries no inline stylesheet');
      return html.slice(opened + '<style>'.length, closed);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/**
 * Rules as `selectors { body }`, comments stripped.
 *
 * Deliberately crude: it does not understand nesting, so an `@media` block's
 * own preamble comes back as a rule with a nonsense selector and its children
 * come back as ordinary rules. That is the right trade for what these tests
 * ask — which declarations exist, and on what — and every caller either keys
 * off a selector shape or ignores the selector entirely.
 */
export function rulesOf(css: string): Rule[] {
  const withoutComments = stripComments(css);
  const out: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = pattern.exec(withoutComments); m !== null; m = pattern.exec(withoutComments)) {
    const selectors = (m[1] ?? '')
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part !== '');
    out.push({ selectors, body: m[2] ?? '' });
  }
  return out;
}

/** Comments are 36% of this sheet and every check below would trip over them. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A rule's declarations as `[property, value]`, lower-cased property. */
export function declarationsOf(rule: Rule): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const chunk of splitTopLevel(rule.body, ';')) {
    const colon = chunk.indexOf(':');
    if (colon < 0) continue;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (property === '' || value === '') continue;
    out.push([property, value]);
  }
  return out;
}

/**
 * Split on a separator that is not inside brackets.
 *
 * `padding:0 calc(8px + env(safe-area-inset-bottom))` has to survive being cut
 * into parts, and a naive split on whitespace or `;` tears the function apart
 * and reports its tail as a stray value.
 */
export function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && (separator === ' ' ? /\s/.test(ch) : ch === separator)) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}
