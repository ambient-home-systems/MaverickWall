/**
 * A secret shown once, on the page *after* the one that made it.
 *
 * A pairing link and an e-paper frame URL are each minted by a POST and shown
 * exactly once — the token is hashed into the database and the clear text
 * lives only in the response that printed it. That is the right property, and
 * the page used to be the POST's own response, which is the wrong place to
 * keep it: reloading that page resubmits the form, so a reload of "Pair a new
 * wall" made a second wall and a reload of "New pairing link" retired the link
 * still on screen — a household who pressed F5 to make the QR redraw revoked
 * the code they were about to type. And the Back button lands on a POST
 * result, which a browser either refuses to show ("document expired") or
 * offers to resubmit.
 *
 * So the POST redirects, and this store carries the secret across the one
 * hop it has to make: the handler that minted it `put`s it under the screen's
 * id, the page the redirect lands on `take`s it, and a second visit to that
 * page finds nothing and says so. That keeps every property the old shape
 * had — shown once, never stored where it could be shown again — and adds
 * the one it lacked: the URL a household is looking at is a GET, safe to
 * reload and safe to come back to, and answers honestly either way.
 *
 * In process and in memory, deliberately. It is the same argument as
 * `device-flow.ts`: a secret that lives for the seconds between a redirect
 * and the page it lands on has nothing worth surviving a restart, and a
 * restart in that window costs one "make a new link" click. Keyed by the
 * screen's id rather than by anything the browser holds, because there is
 * nothing the browser could hold that is not itself a second secret — and a
 * regenerate replaces what is under the key, so the store can never hand
 * over a token the database has since stopped honouring.
 */

/**
 * How long an unread secret waits for the page that shows it.
 *
 * The redirect is followed within milliseconds; this only bounds the memory a
 * POST whose redirect was never followed (a closed tab, a dropped connection)
 * can leave behind. Five minutes is generous for a redirect and short beside
 * the pairing code's own day-long life.
 */
export const REVEAL_TTL_MS = 5 * 60_000;

export interface RevealStore<T> {
  /**
   * Hold `value` under `key` until it is taken or the TTL passes. Replaces
   * anything already held there: a regenerate supersedes the link before it.
   */
  put(key: string, value: T, now: number): void;
  /**
   * The value under `key`, exactly once. A second take, or a take after the
   * TTL, answers `undefined` — and that answer is what the page turns into
   * "this has already been shown".
   */
  take(key: string, now: number): T | undefined;
}

export function createRevealStore<T>(ttlMs: number = REVEAL_TTL_MS): RevealStore<T> {
  const held = new Map<string, { readonly value: T; readonly expiresAt: number }>();

  const prune = (now: number): void => {
    for (const [key, entry] of held) {
      if (now >= entry.expiresAt) held.delete(key);
    }
  };

  return {
    put(key: string, value: T, now: number): void {
      prune(now);
      held.set(key, { value, expiresAt: now + ttlMs });
    },
    take(key: string, now: number): T | undefined {
      prune(now);
      const entry = held.get(key);
      if (entry === undefined) return undefined;
      held.delete(key);
      return entry.value;
    },
  };
}
