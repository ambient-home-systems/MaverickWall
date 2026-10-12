import type { SqliteDatabase } from '../db/open.js';
import { isRole, type Role } from '../auth/roles.js';

/**
 * The household's accounts (plan items M8.1 and M8.2): who may sign in, what
 * each may do, which one Home Assistant's sidebar signs in as, and whether
 * each has turned on two-step sign-in.
 *
 * Creating an account and setting a password go through the auth library's
 * own adapter (`createPasswordAccount`, `setAccountPassword`), because a
 * password is hashed by the thing that checks it. Everything else here is a
 * plain read or write, and every write keeps one rule: **there is always an
 * admin.** A household with no admin has a wall nobody can change and no way
 * to make anybody able to.
 */

export interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly twoFactorEnabled: boolean;
  readonly createdAt: number;
}

export function listAccounts(db: SqliteDatabase): AccountRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, email, role, two_factor_enabled AS twoFactor, created_at AS createdAt
         FROM user ORDER BY created_at, email`,
    )
    .all() as { id: string; name: string; email: string; role: unknown; twoFactor: number; createdAt: number }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: isRole(row.role) ? row.role : 'viewer',
    twoFactorEnabled: row.twoFactor === 1,
    createdAt: row.createdAt,
  }));
}

export function findAccount(db: SqliteDatabase, id: string): AccountRow | undefined {
  return listAccounts(db).find((account) => account.id === id);
}

function adminCount(db: SqliteDatabase): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM user WHERE role = 'admin'`).get() as { n: number }).n;
}

/** The outcome of a change on the Accounts screen: done, or why not. */
export type AccountChange = { readonly ok: true } | { readonly ok: false; readonly message: string };

const LAST_ADMIN = 'This is the only admin. Make another account an admin first, so somebody can still change the wall.';

/** Write a role. Refuses to leave the household with no admin. */
export function setRole(db: SqliteDatabase, id: string, role: Role): AccountChange {
  return db.transaction((): AccountChange => {
    const account = findAccount(db, id);
    if (account === undefined) return { ok: false, message: 'That account is no longer here.' };
    if (account.role === 'admin' && role !== 'admin' && adminCount(db) <= 1) return { ok: false, message: LAST_ADMIN };
    db.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run(role, Date.now(), id);
    return { ok: true };
  })();
}

/**
 * Remove an account: its sessions, its companion token and its two-step
 * secret go with it (each table cascades from `user`, created whole with the
 * key), and the sidebar stops naming it. Never the account doing the removing
 * — an admin who wants to leave asks another to remove them, so the last thing
 * a household does is not lock itself out by its own hand — and never the last
 * admin.
 */
export function deleteAccount(db: SqliteDatabase, id: string, actingUserId: string): AccountChange {
  return db.transaction((): AccountChange => {
    if (id === actingUserId) {
      return { ok: false, message: 'You cannot remove the account you are signed in with. Another admin can.' };
    }
    const account = findAccount(db, id);
    if (account === undefined) return { ok: false, message: 'That account is no longer here.' };
    if (account.role === 'admin' && adminCount(db) <= 1) return { ok: false, message: LAST_ADMIN };
    db.prepare(`UPDATE household_settings SET ingress_user_id = NULL WHERE ingress_user_id = ?`).run(id);
    // Spelled out rather than trusted to the cascade: `session` and `account`
    // cascade in the database, and these three are said here so a schema change
    // that loses one leaves nothing behind that could still sign in.
    db.prepare('DELETE FROM session WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM account WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM two_factor WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM companion_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user WHERE id = ?').run(id);
    return { ok: true };
  })();
}

/**
 * Turn off another account's two-step sign-in, for somebody who has lost both
 * their phone and their recovery codes. Their password still stands; they can
 * turn it on again with a new phone.
 */
export function clearTwoFactor(db: SqliteDatabase, id: string): AccountChange {
  return db.transaction((): AccountChange => {
    if (findAccount(db, id) === undefined) return { ok: false, message: 'That account is no longer here.' };
    db.prepare('DELETE FROM two_factor WHERE user_id = ?').run(id);
    db.prepare('UPDATE user SET two_factor_enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true };
  })();
}

/** The account the sidebar is set to sign in as, whether or not it still exists. */
export function readIngressAccountId(db: SqliteDatabase): string | null {
  try {
    const row = db
      .prepare(`SELECT ingress_user_id AS id FROM household_settings WHERE id = 'singleton'`)
      .get() as { id: string | null } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export function setIngressAccount(db: SqliteDatabase, id: string | null): AccountChange {
  if (id !== null && findAccount(db, id) === undefined) return { ok: false, message: 'That account is no longer here.' };
  db.prepare(`UPDATE household_settings SET ingress_user_id = ? WHERE id = 'singleton'`).run(id);
  return { ok: true };
}

/**
 * Who a Home Assistant sidebar visitor is signed in as (decision MD12 / MQ6):
 * the account the household named; with none named and one account, that
 * account, as it has always been; with none named and several, nobody — there
 * is no telling which person opened the sidebar, so it asks for a password.
 *
 * Never throws: an unreadable table is nobody, which is the sign-in page.
 */
export function ingressAccount(
  db: SqliteDatabase,
): { readonly id: string; readonly email: string; readonly name: string } | undefined {
  try {
    const named = readIngressAccountId(db);
    if (named !== null) {
      const row = db.prepare('SELECT id, email, name FROM user WHERE id = ?').get(named) as
        | { id: string; email: string; name: string }
        | undefined;
      return row;
    }
    const rows = db.prepare('SELECT id, email, name FROM user LIMIT 2').all() as {
      id: string;
      email: string;
      name: string;
    }[];
    return rows.length === 1 ? rows[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accounts whose two-step codes are locked now (M8.3). Better Auth's plugin
 * locks an account for fifteen minutes after ten wrong codes in a row, from
 * any address, and keeps the lock on the account's own row, so it is listed
 * by account rather than by address.
 */
export function twoStepLocks(
  db: SqliteDatabase,
  at: number,
): readonly { readonly id: string; readonly name: string; readonly until: number }[] {
  try {
    return db
      .prepare(
        `SELECT u.id AS id, u.name AS name, t.locked_until AS until
           FROM two_factor t JOIN user u ON u.id = t.user_id
          WHERE t.locked_until IS NOT NULL AND t.locked_until > ?
          ORDER BY t.locked_until`,
      )
      .all(at) as { id: string; name: string; until: number }[];
  } catch {
    return [];
  }
}

/** Lift an account's two-step lock and start its count of wrong codes again. True when there was one. */
export function releaseTwoStepLock(db: SqliteDatabase, id: string, at: number): boolean {
  const result = db
    .prepare(
      `UPDATE two_factor SET failed_verification_count = 0, locked_until = NULL
        WHERE user_id = ? AND locked_until IS NOT NULL AND locked_until > ?`,
    )
    .run(id, at);
  return result.changes > 0;
}
