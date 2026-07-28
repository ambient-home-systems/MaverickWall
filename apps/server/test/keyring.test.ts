import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeyring,
  deriveKey,
  isEnvelope,
  loadOrCreateMasterKey,
  secretEquals,
} from '../src/secrets/keyring.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mw-keyring-'));
  roots.push(dir);
  return dir;
}

/** A real Google private iCal URL shape. This is the thing being protected. */
const FEED_URL =
  'https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/private-9f44ccb50b86ae8c85103f37e0db21da/basic.ics';

describe('master key', () => {
  it('is created once and reused thereafter', () => {
    const dir = scratch();
    const first = loadOrCreateMasterKey(dir);
    expect(first.created).toBe(true);
    expect(first.key.length).toBe(32);

    const second = loadOrCreateMasterKey(dir);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it('restricts permissions and leaves no temporary files', () => {
    const dir = scratch();
    loadOrCreateMasterKey(dir);
    expect((statSync(join(dir, '.secret')).mode & 0o777).toString(8)).toBe('600');
    // The key is written to a temp path and renamed, so a crash mid-write
    // cannot leave a truncated key that would silently decrypt nothing.
    expect(readdirSync(dir).filter((name) => name.includes('tmp'))).toHaveLength(0);
  });

  it('refuses a key file of the wrong size rather than using it', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.secret'), Buffer.alloc(7));
    expect(() => loadOrCreateMasterKey(dir)).toThrow();
  });
});

describe('encryption', () => {
  const dir = scratch();
  const ring = createKeyring(loadOrCreateMasterKey(dir).key);

  it('round-trips a feed URL', () => {
    const sealed = ring.encrypt(FEED_URL, 'calendar-source-url');
    const opened = ring.decrypt(sealed, 'calendar-source-url');
    expect(opened.ok && opened.value).toBe(FEED_URL);
  });

  it('leaks no part of the plaintext into the envelope', () => {
    const sealed = ring.encrypt(FEED_URL, 'calendar-source-url');
    expect(sealed).not.toContain('private-9f44');
    expect(sealed).not.toContain('calendar.google');
    expect(isEnvelope(sealed)).toBe(true);
  });

  it('produces a different envelope every time', () => {
    // A fresh IV per encryption. Without it, identical URLs would produce
    // identical ciphertext and the database would leak which sources match.
    const a = ring.encrypt(FEED_URL, 'calendar-source-url');
    const b = ring.encrypt(FEED_URL, 'calendar-source-url');
    expect(a).not.toBe(b);
    expect(ring.decrypt(a, 'calendar-source-url')).toEqual({ ok: true, value: FEED_URL });
    expect(ring.decrypt(b, 'calendar-source-url')).toEqual({ ok: true, value: FEED_URL });
  });

  it.each(['', 'x', 'unicode ✅ 日本語 🎉', 'line\nbreak\ttab', 'a'.repeat(8192)])(
    'round-trips %s',
    (plaintext) => {
      const opened = ring.decrypt(ring.encrypt(plaintext, 'ha-token'), 'ha-token');
      expect(opened.ok && opened.value).toBe(plaintext);
    },
  );
});

describe('purpose binding', () => {
  const dir = scratch();
  const ring = createKeyring(loadOrCreateMasterKey(dir).key);

  it('refuses to decrypt under a different purpose', () => {
    // The purpose is authenticated, not merely used to select a key. Without
    // that, a ciphertext could be moved between columns and still decrypt — a
    // calendar URL swapped into the Home Assistant token field.
    const sealed = ring.encrypt(FEED_URL, 'calendar-source-url');
    const opened = ring.decrypt(sealed, 'ha-token');
    expect(opened.ok).toBe(false);
    expect(opened.ok === false && opened.reason).toBe('authentication-failed');
  });

  it('derives distinct, deterministic subkeys', () => {
    const master = loadOrCreateMasterKey(dir).key;
    const a = deriveKey(master, 'calendar-source-url');
    const b = deriveKey(master, 'ha-token');
    expect(a.equals(b)).toBe(false);
    expect(deriveKey(master, 'ha-token').equals(b)).toBe(true);
  });
});

describe('failure modes', () => {
  const ring = createKeyring(loadOrCreateMasterKey(scratch()).key);

  it('fails cleanly when the key does not match', () => {
    // The realistic case: a backup restored without its .secret file. Every
    // stored credential becomes undecryptable at once, and the app has to keep
    // running and say which sources need re-entering.
    const other = createKeyring(loadOrCreateMasterKey(scratch()).key);
    const sealed = ring.encrypt(FEED_URL, 'calendar-source-url');
    const opened = other.decrypt(sealed, 'calendar-source-url');
    expect(opened.ok).toBe(false);
    expect(opened.ok === false && opened.reason).toBe('authentication-failed');
  });

  it('detects tampering', () => {
    const sealed = ring.encrypt(FEED_URL, 'calendar-source-url');
    const body = sealed.slice(4);
    const flipped = `mw1.${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    expect(ring.decrypt(flipped, 'calendar-source-url').ok).toBe(false);
    expect(ring.decrypt(sealed.slice(0, 20), 'calendar-source-url').ok).toBe(false);
  });

  it.each(['', 'not-an-envelope', 'mw1.', 'mw1.!!!!', '.', 'mw1.AAAA'])(
    'never throws on %s',
    (bad) => {
      expect(() => ring.decrypt(bad, 'calendar-source-url')).not.toThrow();
      expect(ring.decrypt(bad, 'calendar-source-url').ok).toBe(false);
    },
  );

  it('distinguishes an unknown version from garbage', () => {
    // Forward compatibility: a future envelope format should report as such
    // rather than looking like corruption.
    const future = ring.decrypt('mw9.abc', 'calendar-source-url');
    expect(future.ok === false && future.reason).toBe('unsupported-version');
    const junk = ring.decrypt('nope', 'calendar-source-url');
    expect(junk.ok === false && junk.reason).toBe('malformed');
  });
});

describe('secretEquals', () => {
  it.each([
    ['abc123', 'abc123', true],
    ['abc123', 'abc124', false],
    ['abc', 'abcd', false],
    ['', '', true],
  ] as [string, string, boolean][])('%s vs %s', (a, b, expected) => {
    expect(secretEquals(a, b)).toBe(expected);
  });
});
