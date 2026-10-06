import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { SqliteDatabase } from '../db/open.js';
import { readScreens, type ScreenRow } from '../api/queries.js';
import { manifestEtag, type Manifest } from '../api/manifest.js';
import { PushHub, PUSH_PATH } from './push-hub.js';

/**
 * The push channel, attached to a running server (plan item M1.1, RFC 003 §8).
 *
 * Boot calls this, and so does the browser harness, so a test drives the very
 * wiring a household runs: the upgrade router, the timer and the nudge. It was
 * inline in `main.ts`, where nothing but a real boot could reach it — which is
 * how a wall came to have a socket server for months that no browser wall ever
 * opened.
 *
 * **Two ways a wall hears of a change, and both only say "ask again".** The
 * timer ticks every `tickMs` for what changes on its own — a warning arriving
 * from the weather job, a calendar a sync rewrote, midnight, a timer that
 * finishes. And a write to this server — a layout saved, a timer started from a
 * phone, a chore ticked on another wall — `nudge`s a tick a moment later, so a
 * save reaches every wall in about a second rather than at the next tick or
 * the next minute's poll. The nudge is debounced, because one save is often
 * several requests and one tick answers them all.
 */

/** How long a nudge waits for the rest of the requests one save is made of. */
export const NUDGE_DEBOUNCE_MS = 250;

export interface PushWiring {
  readonly hub: PushHub;
  /** A write happened: tick soon. Safe to call any number of times. */
  nudge(): void;
  close(): void;
}

export function wirePush(
  server: { on?: (event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown },
  deps: {
    readonly db: SqliteDatabase;
    /** The manifest a screen would be served, built by the app — read late, since the app builds it. */
    readonly build: () => ((screen: ScreenRow) => Manifest) | undefined;
    readonly tickMs: number;
    readonly nudgeMs?: number;
    readonly log?: (message: string) => void;
  },
): PushWiring {
  const hub = new PushHub({
    screens: () => readScreens(deps.db),
    evaluate: (screen) => {
      const build = deps.build();
      if (build === undefined) throw new Error('manifest builder not wired');
      const manifest = build(screen);
      return { etag: manifestEtag(manifest), interrupts: manifest.interrupts };
    },
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });

  /*
   * Route only `/d/push` into the hub; anything else upgrading is refused.
   * A wall connects with its display token — the cookie set at pairing, or a
   * bearer from the native app — exactly the credential the poll uses.
   */
  server.on?.('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      // A malformed request-target: refuse rather than guess.
    }
    if (pathname === PUSH_PATH) hub.handleUpgrade(request, socket, head);
    else socket.destroy();
  });

  const timer = setInterval(() => hub.tick(), deps.tickMs);
  timer.unref?.();

  let pending: ReturnType<typeof setTimeout> | undefined;
  return {
    hub,
    nudge(): void {
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        hub.tick();
      }, deps.nudgeMs ?? NUDGE_DEBOUNCE_MS);
      pending.unref?.();
    },
    close(): void {
      clearInterval(timer);
      if (pending !== undefined) clearTimeout(pending);
      hub.close();
    },
  };
}
