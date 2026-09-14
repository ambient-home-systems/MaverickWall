import { randomBytes } from 'node:crypto';

/**
 * A CalDAV account held **provisionally**, between the form and the save
 * (RFC 013 §6.3.1).
 *
 * The add flow is three plain POSTs with no script, and two of them need the
 * password the household typed into the first: the confirmation round trip
 * (§6.3.1) and the calendar picker (§6.7). The password must not cross either
 * of those in the markup, and this is how it does not cross them at all.
 *
 * **It is held here rather than echoed, which is the whole mechanism.** §6.3.1
 * says the confirmation page carries "a hidden field carrying that id, and one
 * Continue button" — so the password "does not cross it at all: it was consumed
 * by the first POST to run discovery and is never read back out of anything to
 * build the confirmation page". Nothing here is ever rendered; the only thing
 * that reaches a browser is the id, which is 32 random bytes and names a
 * secret rather than being one.
 *
 * **In memory and nowhere else**, which is the same argument `logbuffer.ts`
 * makes and one this case makes more strongly: writing it to disk would put a
 * household's Apple ID password in `/data` *before they have agreed to store
 * it*, which is precisely what the confirmation step exists to ask. A restart
 * loses the pending account, and the cost of that is retyping a form — the
 * same cost as the id expiring, which it does anyway.
 *
 * The comparison §6.3.1 draws is a staged restore: held, named by a handle, and
 * applied only when somebody presses the button that means it.
 */

export interface PendingCaldavAccount {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
  /** Set once the household has accepted the host discovery moved to. */
  readonly confirmedHost?: string | null;
  /** What discovery resolved, once it has run to the end. */
  readonly principalUrl?: string;
  readonly homeSetUrl?: string;
}

/**
 * Ten minutes.
 *
 * Long enough to read a confirmation, think about it, and tick four calendars;
 * short enough that a password left in memory by somebody who wandered off is
 * not there at teatime. It is a *floor* on nothing — the entry is dropped on
 * use as well, so the common path holds it for seconds.
 */
const TTL_MS = 10 * 60_000;

/**
 * At most this many at once, oldest dropped first.
 *
 * Rule ten: somebody exposes this to the internet badly. The add route is
 * behind the session gate, so this is not an unauthenticated write — but an
 * unbounded map filled by a form is still a way to spend a household's memory,
 * and a bound costs one line.
 */
const MAX_PENDING = 16;

const pending = new Map<string, { readonly at: number; readonly account: PendingCaldavAccount }>();

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

/** Hold one, and answer the opaque id that names it. */
export function holdPendingCaldav(account: PendingCaldavAccount, now: number): string {
  // 32 bytes, like every other handle this product mints. It names a secret and
  // is not one, but it is still the only thing standing between two signed-in
  // sessions' pending accounts, so it is not a counter.
  const id = randomBytes(32).toString('hex');
  pending.set(id, { at: now, account });
  /*
   * After the insert rather than before it, so the map is never transiently
   * over the bound.
   *
   * **Nothing can observe the difference**, and that is worth saying rather
   * than implying otherwise: `readPendingCaldav` sweeps too, so a map left one
   * over is trimmed before anybody can see it either way. This ordering is
   * tighter and costs nothing; it is not a fix for a fault, and an earlier
   * comment here claimed it was until the mutation that should have proved it
   * turned nothing red.
   */
  sweep(now);
  return id;
}

/**
 * Read one back **without dropping it**, because the confirmation step reads it
 * and then hands it on: the household has one more button to press.
 */
export function readPendingCaldav(id: string, now: number): PendingCaldavAccount | undefined {
  sweep(now);
  return pending.get(id)?.account;
}

/** Replace what is held under an id, keeping the id. Used once the host is confirmed. */
export function updatePendingCaldav(
  id: string,
  account: PendingCaldavAccount,
  now: number,
): void {
  if (!pending.has(id)) return;
  pending.set(id, { at: now, account });
}

/** Drop it, which the save does the moment the row is written. */
export function dropPendingCaldav(id: string): void {
  pending.delete(id);
}

/** Only for tests, which need each case to start from nothing. */
export function clearPendingCaldav(): void {
  pending.clear();
}
