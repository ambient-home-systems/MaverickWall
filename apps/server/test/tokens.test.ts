import { describe, expect, it } from 'vitest';
import {
  formatShortCode,
  hashToken,
  issueDisplayToken,
  issueSetupToken,
  setupTokenValid,
  shortCodeMatches,
  verifyDisplayToken,
} from '../src/auth/tokens.js';

describe('issuing a display token', () => {
  it('produces a fresh high-entropy token each time', () => {
    const a = issueDisplayToken();
    const b = issueDisplayToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url').length).toBe(32);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stores only a hash', () => {
    // A leaked database must not hand out working display credentials.
    const issued = issueDisplayToken();
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token.slice(0, 8));
    expect(issued.tokenHash).toBe(hashToken(issued.token));
  });

  it('never repeats a token across many issues', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(issueDisplayToken().token);
    expect(seen.size).toBe(5000);
  });
});

describe('verifying', () => {
  const issued = issueDisplayToken();

  it('accepts the right token and rejects everything else', () => {
    expect(verifyDisplayToken(issued.token, issued.tokenHash)).toBe(true);
    expect(verifyDisplayToken(issueDisplayToken().token, issued.tokenHash)).toBe(false);
    expect(verifyDisplayToken(issued.token.slice(0, -1), issued.tokenHash)).toBe(false);
    expect(verifyDisplayToken('', issued.tokenHash)).toBe(false);
  });

  it('does not throw on junk', () => {
    // Every screen presents its token on every poll, so this runs constantly
    // and must never be a way to crash the server.
    expect(verifyDisplayToken(issued.token, 'not-hex')).toBe(false);
    expect(verifyDisplayToken(null as unknown as string, issued.tokenHash)).toBe(false);
  });
});

describe('short codes', () => {
  const issued = issueDisplayToken();

  it('avoids characters that are misread from across a room', () => {
    // No 0/O, 1/I/L, 5/S, 8/B. A TV remote and a wall display are the two
    // worst possible conditions for reading a code.
    expect(issued.shortCode).toHaveLength(8);
    expect(issued.shortCode).toMatch(/^[234679ACDEFGHJKMNPQRTUVWXYZ]{8}$/);
  });

  it('accepts what someone would actually type', () => {
    expect(shortCodeMatches(issued.token, issued.shortCode)).toBe(true);
    expect(shortCodeMatches(issued.token, issued.shortCode.toLowerCase())).toBe(true);
    expect(shortCodeMatches(issued.token, formatShortCode(issued.shortCode))).toBe(true);
    expect(
      shortCodeMatches(issued.token, `${issued.shortCode.slice(0, 4)} ${issued.shortCode.slice(4)}`),
    ).toBe(true);
  });

  it('rejects a different code', () => {
    expect(shortCodeMatches(issued.token, issueDisplayToken().shortCode)).toBe(false);
  });

  it('collides rarely enough to be usable', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i++) codes.add(issueDisplayToken().shortCode);
    expect(codes.size).toBeGreaterThan(4990);
  });

  it('formats for reading aloud', () => {
    expect(formatShortCode('ABCD2345')).toBe('ABCD-2345');
  });
});

describe('the first-run setup token', () => {
  // Nobody has a terminal on a wall display and there is no public signup, so
  // the first account is bootstrapped with a short-lived token printed to
  // stdout and shown on screen. Unlike credentials seeded from environment
  // variables, it stops existing once it has been used.
  const NOW = 1_000_000;

  it('expires after thirty minutes', () => {
    const setup = issueSetupToken(NOW);
    expect(setup.expiresAt - NOW).toBe(1_800_000);
    expect(setupTokenValid(setup, setup.token, NOW + 60_000)).toBe(true);
    expect(setupTokenValid(setup, setup.token, NOW + 1_800_001)).toBe(false);
  });

  it('rejects anything but the issued token', () => {
    const setup = issueSetupToken(NOW);
    expect(setupTokenValid(setup, 'nope', NOW)).toBe(false);
    expect(setupTokenValid(setup, '', NOW)).toBe(false);
  });

  it('carries a readable short code for the on-screen prompt', () => {
    expect(issueSetupToken(NOW).shortCode).toMatch(/^[234679ACDEFGHJKMNPQRTUVWXYZ]{8}$/);
  });
});
