import { createFrameParser, FrameTooLarge } from './frames.js';

/**
 * The frame hub (plan item M6.2, RFC 007 §5): one socket into the house per
 * camera, however many walls are watching it, cut into whole frames and
 * handed to each wall under our own boundary.
 *
 * **Frames, not bytes.** A pipe straight through would start a late joiner
 * mid-JPEG and let the slowest tablet set the frame rate for the whole house.
 * The hub owns the frames instead, and five things follow (RFC 007 §5.1): a
 * wall joining is handed the latest frame first; every wall has a mailbox of
 * exactly one frame, so a slow one misses frames and stalls nobody; a
 * reconnect into Home Assistant is invisible to a wall, which sees a pause;
 * a frame is capped in bytes; and a snapshot of a camera that is streaming
 * is the latest frame rather than a second fetch.
 *
 * **Nothing runs unwatched, and everything is bounded** (§5.2): an upstream
 * opens on its first watcher and closes a grace period after its last, so a
 * wall reloading does not thrash the socket; a camera silent for the idle
 * time is reopened quietly, because a still porch can legitimately send
 * nothing (§5.3); no socket lasts longer than the longest a stream may; and
 * only after several opens fail in a row are the watchers told, which is
 * when a wall draws its placeholder.
 *
 * A service the route uses, never a module job: it does not run in manifest
 * assembly and cannot cost the calendar anything.
 */

export interface HubLimits {
  /** Reopen an upstream that has sent no frame for this long. */
  readonly idleMs: number;
  /** No upstream socket outlives this; it is reopened, invisibly. */
  readonly maxDurationMs: number;
  /** A frame larger than this drops the upstream. */
  readonly frameBytes: number;
  /** Upstreams open at once, for the whole house. */
  readonly upstreams: number;
  /** Streams one wall may watch at once. */
  readonly perScreen: number;
  /** Keep an upstream this long after its last watcher leaves. */
  readonly graceMs: number;
  /** Opens that fail in a row before the watchers are told. */
  readonly failuresBeforeEnding: number;
  /** Wait this long before a reopen after a failure, the second after two, and so on. */
  readonly backoffMs: readonly number[];
}

/** RFC 007 §5.2's proposal. A household's measurements may move these; each is a one-line change. */
export const HUB_LIMITS: HubLimits = {
  // Longer than a scene that has not changed (§5.3).
  idleMs: 30_000,
  // A wedged socket cannot last a month.
  maxDurationMs: 10 * 60_000,
  // A 4K snapshot fits; a byte bomb does not.
  frameBytes: 4 * 1024 * 1024,
  // The box is small and so is the house.
  upstreams: 8,
  // A wall is not a security console.
  perScreen: 4,
  // A reloading wall must not reopen the socket.
  graceMs: 5_000,
  failuresBeforeEnding: 3,
  backoffMs: [1_000, 2_000, 5_000, 10_000],
};

/** What opening an upstream gives back: the bytes as they come, and a way to stop them. */
export type OpenedUpstream =
  | { readonly ok: true; readonly chunks: AsyncIterable<Uint8Array>; close(): void }
  | { readonly ok: false };

export interface Subscription {
  /** The next frame for this watcher, or nothing once the stream has ended. */
  next(): Promise<Uint8Array | undefined>;
  close(): void;
}

export type SubscribeResult =
  | { readonly ok: true; readonly subscription: Subscription }
  | { readonly ok: false; readonly reason: 'screen-full' | 'house-full' };

interface Watcher {
  readonly screenId: string;
  mailbox: Uint8Array | undefined;
  waiting: ((frame: Uint8Array | undefined) => void) | undefined;
  ended: boolean;
}

interface Upstream {
  readonly handle: string;
  readonly watchers: Set<Watcher>;
  latest: Uint8Array | undefined;
  current: { close(): void } | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

export interface CameraHub {
  subscribe(handle: string, screenId: string): SubscribeResult;
  /** The latest frame of a camera whose upstream is open, for a snapshot (§5.4). */
  latest(handle: string): Uint8Array | undefined;
  /** End every stream a wall holds — it was revoked. */
  endScreen(screenId: string): void;
  /** End every stream of one camera — it was removed. */
  endCamera(handle: string): void;
  /** How many upstream sockets are open or opening, for the tests that count them. */
  upstreamCount(): number;
}

export function createCameraHub(
  open: (handle: string) => Promise<OpenedUpstream>,
  limits: HubLimits = HUB_LIMITS,
): CameraHub {
  const upstreams = new Map<string, Upstream>();

  const deliver = (watcher: Watcher, frame: Uint8Array): void => {
    if (watcher.ended) return;
    if (watcher.waiting !== undefined) {
      const resolve = watcher.waiting;
      watcher.waiting = undefined;
      resolve(frame);
      return;
    }
    // A mailbox of one: a newer frame replaces an unread one.
    watcher.mailbox = frame;
  };

  const endWatcher = (watcher: Watcher): void => {
    if (watcher.ended) return;
    watcher.ended = true;
    watcher.mailbox = undefined;
    const resolve = watcher.waiting;
    watcher.waiting = undefined;
    resolve?.(undefined);
  };

  const stop = (upstream: Upstream): void => {
    upstream.stopped = true;
    if (upstream.grace !== undefined) clearTimeout(upstream.grace);
    upstream.current?.close();
    upstream.current = undefined;
    upstream.latest = undefined;
    for (const watcher of upstream.watchers) endWatcher(watcher);
    upstream.watchers.clear();
    if (upstreams.get(upstream.handle) === upstream) upstreams.delete(upstream.handle);
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function run(upstream: Upstream): Promise<void> {
    let failures = 0;
    while (!upstream.stopped) {
      const opened = await open(upstream.handle);
      if (upstream.stopped) {
        if (opened.ok) opened.close();
        return;
      }
      if (!opened.ok) {
        failures += 1;
        if (failures >= limits.failuresBeforeEnding) {
          stop(upstream);
          return;
        }
        await sleep(limits.backoffMs[Math.min(failures - 1, limits.backoffMs.length - 1)] ?? 1_000);
        continue;
      }
      upstream.current = opened;
      const parser = createFrameParser(limits.frameBytes);
      let idle = setTimeout(() => opened.close(), limits.idleMs);
      const lifetime = setTimeout(() => opened.close(), limits.maxDurationMs);
      let tooLarge = false;
      let sawFrame = false;
      try {
        for await (const chunk of opened.chunks) {
          if (upstream.stopped) break;
          let frames: Uint8Array[];
          try {
            frames = parser.push(chunk);
          } catch (error) {
            if (!(error instanceof FrameTooLarge)) throw error;
            tooLarge = true;
            break;
          }
          for (const frame of frames) {
            sawFrame = true;
            upstream.latest = frame;
            clearTimeout(idle);
            idle = setTimeout(() => opened.close(), limits.idleMs);
            for (const watcher of upstream.watchers) deliver(watcher, frame);
          }
        }
      } catch {
        // A stream that throws has ended; it is reopened below like one that closed.
      } finally {
        clearTimeout(idle);
        clearTimeout(lifetime);
        opened.close();
        upstream.current = undefined;
      }
      if (upstream.stopped) return;
      // A source that sends a frame too big, or opens and sends nothing at all,
      // counts against it; one that sent frames and then went quiet or reached
      // its time is simply reopened (§5.3).
      if (tooLarge || !sawFrame) {
        failures += 1;
        if (failures >= limits.failuresBeforeEnding) {
          stop(upstream);
          return;
        }
        await sleep(limits.backoffMs[Math.min(failures - 1, limits.backoffMs.length - 1)] ?? 1_000);
      } else {
        failures = 0;
      }
    }
  }

  return {
    subscribe(handle: string, screenId: string): SubscribeResult {
      let mine = 0;
      for (const upstream of upstreams.values()) {
        for (const watcher of upstream.watchers) if (watcher.screenId === screenId) mine += 1;
      }
      if (mine >= limits.perScreen) return { ok: false, reason: 'screen-full' };
      let upstream = upstreams.get(handle);
      if (upstream === undefined) {
        if (upstreams.size >= limits.upstreams) return { ok: false, reason: 'house-full' };
        upstream = { handle, watchers: new Set(), latest: undefined, current: undefined, grace: undefined, stopped: false };
        upstreams.set(handle, upstream);
        void run(upstream);
      }
      if (upstream.grace !== undefined) {
        clearTimeout(upstream.grace);
        upstream.grace = undefined;
      }
      // A late joiner is handed the latest frame first, so it paints at once.
      const watcher: Watcher = { screenId, mailbox: upstream.latest, waiting: undefined, ended: false };
      upstream.watchers.add(watcher);
      const owner = upstream;
      return {
        ok: true,
        subscription: {
          next(): Promise<Uint8Array | undefined> {
            if (watcher.ended) return Promise.resolve(undefined);
            if (watcher.mailbox !== undefined) {
              const frame = watcher.mailbox;
              watcher.mailbox = undefined;
              return Promise.resolve(frame);
            }
            return new Promise((resolve) => {
              watcher.waiting = resolve;
            });
          },
          close(): void {
            endWatcher(watcher);
            owner.watchers.delete(watcher);
            if (owner.watchers.size === 0 && !owner.stopped && owner.grace === undefined) {
              owner.grace = setTimeout(() => {
                owner.grace = undefined;
                if (owner.watchers.size === 0) stop(owner);
              }, limits.graceMs);
            }
          },
        },
      };
    },
    latest(handle: string): Uint8Array | undefined {
      return upstreams.get(handle)?.latest;
    },
    endScreen(screenId: string): void {
      for (const upstream of Array.from(upstreams.values())) {
        for (const watcher of Array.from(upstream.watchers)) {
          if (watcher.screenId !== screenId) continue;
          endWatcher(watcher);
          upstream.watchers.delete(watcher);
        }
        if (upstream.watchers.size === 0) stop(upstream);
      }
    },
    endCamera(handle: string): void {
      const upstream = upstreams.get(handle);
      if (upstream !== undefined) stop(upstream);
    },
    upstreamCount(): number {
      return upstreams.size;
    },
  };
}
