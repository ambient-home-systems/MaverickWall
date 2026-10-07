import { randomBytes } from 'node:crypto';
import type { OAuthProvider } from '../oauth/endpoints.js';
import type { RemoteCalendar } from '../oauth/calendars.js';

/**
 * A Google or Microsoft sign-in **in progress**, between the press that starts
 * it and the save that stores it (plan item M5.11).
 *
 * `caldav-pending.ts`'s shape and argument, for the same reasons: a sign-in
 * crosses two or three plain POSTs (and, for Google, a trip to Google and a
 * GET back), and what it carries — a client secret, a device code, a PKCE
 * verifier, and once the household has signed in a refresh token — must not
 * cross any of them in the markup. So it is held here under an opaque id and
 * only the id reaches a browser. In memory and nowhere else: a refresh token
 * written to `/data` before the household has picked a calendar is a sign-in
 * stored before they agreed to keep it.
 *
 * Google's `state` parameter **is** the id. It is 32 random bytes minted by the
 * household's own POST and held only here, so a callback carrying any other
 * value — a forged one, or one from a sign-in that expired — names nothing.
 */

export type PendingOAuth =
  | {
      readonly step: 'microsoft-code';
      readonly clientId: string;
      readonly tenant: string;
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
      /** Signing an existing account in again, rather than adding one. */
      readonly reauth?: string;
    }
  | {
      readonly step: 'google-consent';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly verifier: string;
      readonly reauth?: string;
    }
  | {
      readonly step: 'pick';
      readonly provider: OAuthProvider;
      /** Set when the calendars are being added to an account already stored. */
      readonly accountId?: string;
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly tenant?: string;
      readonly refreshToken?: string;
      readonly label?: string;
      readonly calendars: readonly RemoteCalendar[];
    };

/**
 * Fifteen minutes, which is how long Microsoft's device codes last: a code
 * still valid at Microsoft must not have been forgotten here.
 */
const TTL_MS = 15 * 60_000;

/** At most this many at once, oldest dropped first — `caldav-pending`'s bound, for its reason. */
const MAX_PENDING = 16;

const pending = new Map<string, { readonly at: number; readonly held: PendingOAuth }>();

function sweep(now: number): void {
  for (const [id, entry] of pending) {
    if (now - entry.at > TTL_MS) pending.delete(id);
  }
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done === true) break;
    pending.delete(oldest.value);
  }
}

export function holdPendingOAuth(held: PendingOAuth, now: number): string {
  const id = randomBytes(32).toString('hex');
  pending.set(id, { at: now, held });
  sweep(now);
  return id;
}

export function readPendingOAuth(id: string, now: number): PendingOAuth | undefined {
  sweep(now);
  return pending.get(id)?.held;
}

export function dropPendingOAuth(id: string): void {
  pending.delete(id);
}

/** Only for tests, which need each case to start from nothing. */
export function clearPendingOAuth(): void {
  pending.clear();
}
