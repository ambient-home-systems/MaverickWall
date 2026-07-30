import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Display tokens.
 *
 * A wall tablet cannot log in. There is no keyboard, nobody is standing there,
 * and it has to survive months of unattended reboots. So a screen carries a
 * long random token instead, shown once at pairing and never again.
 *
 * Proportionality matters here. This is a LAN service for one household, not a
 * SaaS: no rotation ceremony, no refresh flow, no expiry. One token per screen,
 * revocable with one button. The threat being defended against is a curious
 * guest on the wifi, not a targeted attacker, and over-building it would make
 * the setup experience worse for no security gained.
 *
 * Tokens are stored hashed. That costs nothing — they are high entropy, so no
 * slow KDF is needed — and it means a leaked database does not hand out working
 * display credentials.
 */

/** 32 bytes of entropy. Long enough that guessing is not a consideration. */
const TOKEN_BYTES = 32;

/**
 * A short code for entry on a TV remote.
 *
 * Deliberately excludes characters that are misread from across a room or
 * mistyped on a numeric pad: 0/O, 1/I/L, 5/S, 8/B. What remains is unambiguous
 * in the fonts a wall display uses.
 */
const SHORT_CODE_ALPHABET = '234679ACDEFGHJKMNPQRTUVWXYZ';
const SHORT_CODE_LENGTH = 8;

export interface IssuedToken {
  /** Shown once, then discarded. Goes in the QR code. */
  readonly token: string;
  /** What the database stores. */
  readonly tokenHash: string;
  /** Typed by hand when a QR code is not practical. */
  readonly shortCode: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function shortCodeFrom(token: string): string {
  // Derived from the token rather than generated separately, so the two cannot
  // drift apart and only one secret has to be stored.
  const digest = createHash('sha256').update(`short:${token}`, 'utf8').digest();
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_ALPHABET[digest[i]! % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

export function issueDisplayToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token), shortCode: shortCodeFrom(token) };
}

/**
 * Constant-time comparison of a presented token against a stored hash.
 *
 * Every screen presents its token on every poll, which is exactly the
 * repetition a timing attack needs.
 */
export function verifyDisplayToken(presented: string, storedHash: string): boolean {
  if (typeof presented !== 'string' || typeof storedHash !== 'string') return false;
  const presentedHash = Buffer.from(hashToken(presented), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/** True when a short code matches the token, ignoring case and spacing. */
export function shortCodeMatches(token: string, presented: string): boolean {
  const normalised = presented.replace(/[\s-]/g, '').toUpperCase();
  const expected = shortCodeFrom(token);
  if (normalised.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(normalised, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * A one-time setup token, printed to stdout on first boot.
 *
 * Nobody has a terminal on a wall display, and there is no public signup, so
 * the first account has to be bootstrapped somehow. This is short-lived, single
 * use, and dies the moment an account exists — unlike credentials seeded from
 * environment variables, which persist in the container configuration for as
 * long as it runs.
 */
export interface SetupToken {
  readonly token: string;
  readonly shortCode: string;
  readonly expiresAt: number;
}

const SETUP_TOKEN_TTL_MS = 30 * 60_000;

export function issueSetupToken(now: number = Date.now()): SetupToken {
  const token = randomBytes(24).toString('base64url');
  return { token, shortCode: shortCodeFrom(token), expiresAt: now + SETUP_TOKEN_TTL_MS };
}

export function setupTokenValid(setup: SetupToken, presented: string, now: number = Date.now()): boolean {
  if (now > setup.expiresAt) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(setup.token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Format for reading aloud or off a screen: `ABCD-EFGH`. */
export function formatShortCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
