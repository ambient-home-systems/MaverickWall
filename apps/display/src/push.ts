/**
 * The wall's end of the push channel (plan item M1.1, RFC 003 §8).
 *
 * **It carries no data, only a reason to ask again.** Every message the server
 * sends — a manifest that changed, a warning that arrived — becomes one poll
 * of `/d/manifest`, the same request the sixty-second timer makes, with the
 * same ETag and the same 304. So nothing on the wall depends on a message
 * arriving: a socket that never opens, drops, or is refused leaves the wall
 * exactly as it was before this existed, a minute behind at worst. What the
 * socket buys is that a saved layout, a timer started from a phone or a ticked
 * chore reaches the wall in about a second.
 *
 * The cookie the wall was paired with travels on the upgrade by itself — a
 * WebSocket handshake to the page's own origin carries its cookies — so there
 * is no token here to leak. Same origin and nowhere else, which is rule three
 * and what the display's `connect-src` allows.
 */

/** What this module needs of a WebSocket: the four handlers, and close. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface PushOptions {
  readonly url: string;
  /** Ask the server again — the wall's own poll. */
  readonly onNudge: () => void;
  readonly createSocket?: (url: string) => SocketLike;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly random?: () => number;
}

/** The longest a wall waits between attempts: the poll's own minute, since past that the poll is what counts. */
export const PUSH_RETRY_MAX_MS = 60_000;
const PUSH_RETRY_FIRST_MS = 1_000;

/**
 * How long to wait before attempt `attempt` (0 for the first retry).
 *
 * Doubling from a second to a minute, with **equal jitter** — half the wait is
 * fixed and half is random — rather than full jitter, because the fixed half is
 * what stops a dozen walls that lost the same server at the same moment from
 * hammering it the instant it comes back, and the random half is what spreads
 * them out.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(PUSH_RETRY_MAX_MS, PUSH_RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The socket's address for a page at `location`: its own host, `wss:` under https. */
export function pushUrl(location: { readonly protocol: string; readonly host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/d/push`;
}

/**
 * Whether a message is one the server sends. Anything else — a stranger's
 * frame, a protocol from a newer server — is ignored rather than acted on,
 * though acting on it would only have been a poll.
 */
export function isNudge(data: unknown): boolean {
  if (typeof data !== 'string' || data.length > 1_000_000) return false;
  try {
    const message = JSON.parse(data) as { type?: unknown; protocol?: unknown };
    return (
      (message.type === 'MANIFEST_CHANGED' || message.type === 'INTERRUPT_PUSH') && message.protocol === 1
    );
  } catch {
    return false;
  }
}

/**
 * Open the socket and keep it open. Answers a `stop`, for a wall that is
 * unpaired and has nothing to be told.
 */
export function startPush(options: PushOptions): { stop(): void; readonly connected: () => boolean } {
  const create = options.createSocket ?? ((url: string): SocketLike => new WebSocket(url) as unknown as SocketLike);
  const setTimer = options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;

  let socket: SocketLike | undefined;
  let open = false;
  let attempt = 0;
  let retry: unknown;
  let stopped = false;

  const connect = (): void => {
    retry = undefined;
    if (stopped) return;
    let next: SocketLike;
    try {
      next = create(options.url);
    } catch {
      // A browser with no WebSocket at all, or a URL it will not take: the
      // poll carries this wall, so try again later rather than never.
      schedule();
      return;
    }
    socket = next;
    next.onopen = (): void => {
      open = true;
      attempt = 0;
    };
    next.onmessage = (event): void => {
      if (isNudge(event.data)) options.onNudge();
    };
    // An error is followed by a close; the close is the one place a retry is
    // scheduled, so a failed attempt is never retried twice.
    next.onerror = (): void => {};
    next.onclose = (): void => {
      open = false;
      if (socket === next) socket = undefined;
      schedule();
    };
  };

  const schedule = (): void => {
    if (stopped || retry !== undefined) return;
    retry = setTimer(connect, retryDelay(attempt, random));
    attempt += 1;
  };

  connect();
  return {
    stop(): void {
      stopped = true;
      if (retry !== undefined) clearTimer(retry);
      retry = undefined;
      const current = socket;
      socket = undefined;
      open = false;
      try {
        current?.close();
      } catch {
        // Already gone.
      }
    },
    connected: (): boolean => open,
  };
}
