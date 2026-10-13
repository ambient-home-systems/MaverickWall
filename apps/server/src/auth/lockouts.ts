/**
 * The in-app rate limits, kept where an admin can see and lift them (plan item
 * M8.3).
 *
 * Rule ten asks for rate limiting in the app, and it was there: sign-in, the
 * wall's pairing code, a wall starting a pairing, and the phone's token each
 * stop an address that keeps getting it wrong. What nobody could do was see
 * one. A household locked out of its own sign-in page by a misbehaving script
 * on the LAN, or a phone shortcut sent to wait because an old token was still
 * being tried somewhere, had no way to learn which address, or for how long,
 * or to let it back in.
 *
 * So each limit is one of these, owned by the app instance (not module-global,
 * for the reason the pairing limit always gave: tests keyed to one address
 * stay independent), and the Lockouts screen reads them all. **Addresses only.**
 * A limit is keyed on where a request came from and nothing else, and the
 * attempt log beside it records the step and the outcome — never the email
 * typed, never a code, never a token.
 */

/** A fixed window: a count per key that resets once its window has passed. */
export interface FixedWindow {
  /** Count one more. True when that one is over the limit. */
  hit(key: string, at: number): boolean;
  /** Seconds until this key may try again, or undefined when it may now. */
  wait(key: string, at: number): number | undefined;
  /** Every key that would be refused now, and until when. */
  held(at: number): readonly { readonly key: string; readonly until: number }[];
  /** Forget a key's count, so its next try is its first. */
  release(key: string): boolean;
}

export function createFixedWindow(windowMs: number, max: number): FixedWindow {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, at) {
      const bucket = buckets.get(key);
      if (bucket === undefined || at > bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: at + windowMs });
        return false;
      }
      bucket.count += 1;
      return bucket.count > max;
    },
    wait(key, at) {
      const bucket = buckets.get(key);
      if (bucket === undefined || at > bucket.resetAt || bucket.count < max) return undefined;
      return Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
    },
    held(at) {
      const out: { key: string; until: number }[] = [];
      for (const [key, bucket] of buckets) {
        if (at > bucket.resetAt) buckets.delete(key);
        else if (bucket.count >= max) out.push({ key, until: bucket.resetAt });
      }
      return out;
    },
    release(key) {
      return buckets.delete(key);
    },
  };
}

/**
 * Better Auth's own sign-in limit, with its counters kept here instead of in
 * the library's module-global map.
 *
 * The library takes a storage with one operation, `consume`, and decides the
 * window and the ceiling per path itself (three sign-ins in ten seconds per
 * address, the two-step routes three in ten, everything else twenty a
 * minute). This is that operation with the library's own semantics, written
 * out so the counters are somewhere this screen can list and lift: a refused
 * request does not move the window, and a window that has passed starts again
 * at one. Its keys are the library's, `<address>|<path>`.
 */
export interface SignInLimits {
  consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
  held(at: number): readonly { readonly address: string; readonly until: number }[];
  /** Lift every limit on one address. True when there was one to lift. */
  release(address: string): boolean;
}

export function createSignInLimits(now: () => number = Date.now): SignInLimits {
  const entries = new Map<string, { count: number; lastRequest: number; window: number; max: number }>();
  const addressOf = (key: string): string => key.slice(0, key.lastIndexOf('|'));
  return {
    async consume(key, rule) {
      const at = now();
      const windowMs = rule.window * 1000;
      const entry = entries.get(key);
      if (entry === undefined || at - entry.lastRequest >= windowMs) {
        entries.set(key, { count: 1, lastRequest: at, window: rule.window, max: rule.max });
        return { allowed: true, retryAfter: null };
      }
      if (entry.count >= rule.max) {
        return { allowed: false, retryAfter: Math.ceil((entry.lastRequest + windowMs - at) / 1000) };
      }
      entry.count += 1;
      entry.lastRequest = at;
      entry.window = rule.window;
      entry.max = rule.max;
      return { allowed: true, retryAfter: null };
    },
    held(at) {
      const latest = new Map<string, number>();
      for (const [key, entry] of entries) {
        const until = entry.lastRequest + entry.window * 1000;
        if (at >= until) {
          entries.delete(key);
          continue;
        }
        if (entry.count < entry.max) continue;
        const address = addressOf(key);
        latest.set(address, Math.max(latest.get(address) ?? 0, until));
      }
      return [...latest].map(([address, until]) => ({ address, until }));
    },
    release(address) {
      let any = false;
      for (const key of [...entries.keys()]) {
        if (addressOf(key) === address) {
          entries.delete(key);
          any = true;
        }
      }
      return any;
    },
  };
}

/** Which door a sign-in attempt came through. */
export type SignInStep = 'password' | 'code' | 'recovery';

/** What came of it, in the words the Lockouts screen uses. */
export type SignInOutcome = 'signed-in' | 'code-asked' | 'refused' | 'too-many';

export interface SignInAttempt {
  readonly at: number;
  /** Where it came from, or undefined when the socket could not say. */
  readonly address: string | undefined;
  readonly step: SignInStep;
  readonly outcome: SignInOutcome;
}

/**
 * The recent sign-in attempts, newest first: the last hundred, and none older
 * than a day. In memory, so a restart forgets them — said on the screen —
 * because what this is for is "who is knocking right now", and a table that
 * kept every knock for ever would be a record of the household's comings and
 * goings that nothing needs.
 */
export interface SignInLog {
  record(attempt: SignInAttempt): void;
  recent(at: number): readonly SignInAttempt[];
}

export const SIGN_IN_LOG_SIZE = 100;
export const SIGN_IN_LOG_AGE_MS = 24 * 60 * 60_000;

export function createSignInLog(): SignInLog {
  const attempts: SignInAttempt[] = [];
  return {
    record(attempt) {
      attempts.unshift(attempt);
      if (attempts.length > SIGN_IN_LOG_SIZE) attempts.length = SIGN_IN_LOG_SIZE;
    },
    recent(at) {
      return attempts.filter((attempt) => at - attempt.at < SIGN_IN_LOG_AGE_MS);
    },
  };
}

/** Every limit the app keeps, by what it guards. */
export interface Lockouts {
  readonly signIn: SignInLimits;
  readonly pairing: FixedWindow;
  readonly wallStart: FixedWindow;
  readonly phoneToken: FixedWindow;
  readonly log: SignInLog;
}

/** The address-keyed limits' kinds, as the release form names them. */
export const ADDRESS_LOCKS = ['sign-in', 'pairing', 'wall-start', 'phone-token'] as const;
export type AddressLock = (typeof ADDRESS_LOCKS)[number];

/** The key a request with no known address is counted under, shared by all of them. */
export const NO_ADDRESS = 'shared';
