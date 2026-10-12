import type { SqliteDatabase } from '../db/open.js';

/**
 * What an account may do (plan item M8.1, decision MD12).
 *
 * Two roles. **Admin** is what every account was before this existed. **View
 * only** may look at everything and change nothing — stricter than Magic
 * Frame, whose view-only accounts can still edit layouts, and deliberately: a
 * second person in the house who wants to see why the wall says what it says
 * should not be one tap from moving the boxes.
 *
 * Pure apart from the one read, and the read fails closed, for rule ten: a
 * role this process cannot read is a view-only account, which can still look
 * — so a database too damaged to answer leaves the admin readable rather than
 * writable by whoever is signed in.
 */

export type Role = 'admin' | 'viewer';

export const ROLES: readonly Role[] = ['admin', 'viewer'];

export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'viewer';
}

/** What a household reads for each role, wherever one is named. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: 'Admin',
  viewer: 'View only',
};

/** The sentence a refused view-only request is answered with. */
export const VIEW_ONLY_REFUSAL =
  'This account can look at everything but not change anything. ' +
  'Ask an admin to make the change, or to make your account an admin.';

/** An account's role, read fresh on every request. Unknown or unreadable is view-only. */
export function readUserRole(db: SqliteDatabase, userId: string): Role {
  try {
    const row = db.prepare('SELECT role FROM user WHERE id = ?').get(userId) as { role: unknown } | undefined;
    return row !== undefined && isRole(row.role) ? row.role : 'viewer';
  } catch {
    return 'viewer';
  }
}

/**
 * Reads a view-only account is refused, because each one hands out a
 * credential rather than showing a setting: the database and the master key,
 * the companion token, and the two one-hop reveals of a wall's pairing link
 * and a panel's frame address. "Look at everything" is a sentence about the
 * household's settings; a key to the house is not one of them.
 *
 * The reveals are also writes — showing one spends it — which is a second
 * reason they are an admin's.
 */
const REFUSED_READS: readonly RegExp[] = [
  /^\/admin\/system\/(backup|key)(\/|$)/,
  /^\/admin\/companion(\/|$)/,
  /^\/admin\/walls\/[^/]+\/pair\/?$/,
  /^\/admin\/epaper\/[^/]+\/url\/?$/,
];

/**
 * Writes a view-only account may make, because they are about the account and
 * not the household: signing out, and its own password and two-step sign-in.
 */
const OWN_ACCOUNT_WRITES: readonly RegExp[] = [/^\/admin\/sign-out\/?$/, /^\/admin\/account(\/|$)/];

/** Whether a view-only account may make this request. */
export function viewerMay(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  if (read) return !REFUSED_READS.some((pattern) => pattern.test(path));
  return OWN_ACCOUNT_WRITES.some((pattern) => pattern.test(path));
}
