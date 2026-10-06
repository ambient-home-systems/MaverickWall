import { randomBytes } from 'node:crypto';

import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { hashToken, verifyDisplayToken } from '../auth/tokens.js';

/**
 * The companion token (plan item M2.1): one per account, for a phone shortcut
 * or a Home Assistant automation to present instead of a session.
 *
 * **The prefix is for the redactor, not for decoration.** A token shaped like
 * every other run of base64url is caught by `looksLikeSecret`'s entropy rule
 * most of the time, and "most of the time" is one in 1,818 (`redact.ts` says
 * so). A fixed `mwc_` in front is a rule that holds for every token, so
 * `redactLogText` names it outright — and a household who pastes one into a
 * forum post can tell at a glance what it is.
 */
export const COMPANION_TOKEN_PREFIX = 'mwc_';

/** 32 bytes, the display token's length and for its reason: guessing is not a consideration. */
const TOKEN_BYTES = 32;

export interface CompanionTokenView {
  /** The token, opened from its sealed copy. Undefined when it cannot be opened — a key restored without its database, say. */
  readonly token: string | undefined;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

/**
 * Make a fresh token for an account, replacing any it had.
 *
 * Creating and rotating are one function, because they are one act: an account
 * has at most one live token, and the old one stops working the moment this
 * returns. Shortcuts already holding it get a 401 that says so.
 */
export function issueCompanionToken(db: SqliteDatabase, keyring: Keyring, userId: string, now: number): string {
  const token = `${COMPANION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  db.prepare(
    `INSERT INTO companion_tokens (user_id, token_hash, token_encrypted, created_at, last_used_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       token_encrypted = excluded.token_encrypted,
       created_at = excluded.created_at,
       last_used_at = NULL`,
  ).run(userId, hashToken(token), keyring.encrypt(token, 'companion-token'), now);
  return token;
}

/** The account's token, for the admin to show. Undefined when it has none. */
export function readCompanionToken(
  db: SqliteDatabase,
  keyring: Keyring,
  userId: string,
): CompanionTokenView | undefined {
  const row = db
    .prepare(
      `SELECT token_encrypted AS sealed, created_at AS createdAt, last_used_at AS lastUsedAt
         FROM companion_tokens WHERE user_id = ?`,
    )
    .get(userId) as { sealed: string; createdAt: number; lastUsedAt: number | null } | undefined;
  if (row === undefined) return undefined;
  const opened = keyring.decrypt(row.sealed, 'companion-token');
  return { token: opened.ok ? opened.value : undefined, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

/** Turn an account's token off. False when it had none, so the admin claims nothing it did not do. */
export function revokeCompanionToken(db: SqliteDatabase, userId: string): boolean {
  return db.prepare('DELETE FROM companion_tokens WHERE user_id = ?').run(userId).changes > 0;
}

/**
 * Which account a presented token belongs to, or undefined.
 *
 * Every row is compared, in constant time, rather than looked up by its hash —
 * `authenticateScreen`'s shape, for its reason: the token is presented on every
 * call, which is the repetition a timing attack needs. There is one row per
 * account, so walking them costs nothing. A token without the prefix is refused
 * before any comparison, which is a fact about the format rather than a secret.
 */
export function authenticateCompanion(db: SqliteDatabase, presented: string): string | undefined {
  if (!presented.startsWith(COMPANION_TOKEN_PREFIX)) return undefined;
  const rows = db.prepare('SELECT user_id AS userId, token_hash AS tokenHash FROM companion_tokens').all() as {
    userId: string;
    tokenHash: string;
  }[];
  let found: string | undefined;
  for (const row of rows) {
    // No early return: every row is compared whichever one matches.
    if (verifyDisplayToken(presented, row.tokenHash)) found = row.userId;
  }
  return found;
}

/** Stamp a successful use. Kept to the minute, which is all the admin says. */
export function touchCompanionToken(db: SqliteDatabase, userId: string, now: number): void {
  db.prepare('UPDATE companion_tokens SET last_used_at = ? WHERE user_id = ?').run(now, userId);
}

/**
 * Where a request carried its token.
 *
 * `Authorization: Bearer` is the one to use and wins when both are present.
 * `?key=` exists because an iOS Shortcut is easier to write as one address
 * than as an address and a header — and an address is what proxies, routers and
 * Home Assistant's own history write down, which the admin says beside it.
 */
export function presentedCompanionToken(
  authorization: string | undefined,
  key: string | undefined,
): { readonly token: string; readonly via: 'header' | 'query' } | undefined {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (bearer !== null) return { token: bearer[1]!, via: 'header' };
  if (typeof key === 'string' && key !== '') return { token: key, via: 'query' };
  return undefined;
}
