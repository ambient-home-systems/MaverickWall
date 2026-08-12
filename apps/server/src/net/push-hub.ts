import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Interrupt } from '@maverick-wall/core';
import { authenticateScreenToken } from '../auth/screen-token.js';
import { interruptPush, manifestChangedPush } from '../api/push.js';
import type { ScreenRow } from '../api/queries.js';

/**
 * The self-hosted push channel.
 *
 * The wall polls `/d/manifest` every sixty seconds and that is what carries
 * interrupts today — this socket is the optimisation the push contract
 * (`api/push.ts`) has been waiting for, and never a dependency. If it drops, a
 * reconnecting display gets the same interrupts on its next poll; nothing the
 * app relies on lives only on the wire. That is the whole reason it is safe to
 * build this after the fact: it changes latency, not correctness.
 *
 * There is no cloud here (rule three): the socket is the household's own
 * server talking to the household's own screens over the LAN. No FCM, no relay.
 *
 * A pushed message is derived from the very same manifest a poll would return
 * (`deps.evaluate`), so a `MANIFEST_CHANGED` etag can never disagree with what
 * the next `/d/manifest` hands back — the drift this project keeps being bitten
 * by is designed out rather than tested against.
 */

/** The path a screen opens the socket on. Under one origin, beside `/d/*`. */
export const PUSH_PATH = '/d/push';

/** What a screen's manifest reduces to for push purposes. */
export interface PushState {
  /** The manifest etag — the same string `/d/manifest` sends. */
  readonly etag: string;
  /** The interrupts in force for this screen, loudest first. */
  readonly interrupts: readonly Interrupt[];
}

export interface PushHubDeps {
  /**
   * The screens as they stand right now, read fresh per upgrade and per tick.
   *
   * Fresh rather than cached because a revoked screen must lose its socket, and
   * a token rotated by a re-pair must stop authenticating — a stale list would
   * keep a screen the household has removed talking to the wall.
   */
  readonly screens: () => readonly ScreenRow[];
  /**
   * A screen's push state — the same document `/d/manifest` builds for it.
   *
   * Injected so the transport here stays free of the manifest domain and can be
   * driven by a real socket in a test without the whole app, and so the wall
   * and the socket cannot compute two different answers.
   */
  readonly evaluate: (screen: ScreenRow) => PushState;
  readonly now?: () => number;
  /** Where a line about a connect/close/refuse goes. Hostnames only, rule six. */
  readonly log?: (message: string) => void;
}

/** One live socket, and what it was last told, so a tick sends only changes. */
interface Connection {
  readonly screenId: string;
  lastEtag: string;
  lastInterruptKey: string;
}

/**
 * A stable fingerprint of an interrupt set, for change detection.
 *
 * Deliberately not the whole object: `expiresAt` and the like drift on every
 * evaluation and would push a spurious wake each tick. What a screen must react
 * to is a warning appearing, changing action, or asking for a wake — so those
 * are the only fields folded in. Order is the evaluator's (loudest first) and
 * is itself meaningful, so it is preserved rather than sorted away.
 */
function interruptKey(interrupts: readonly Interrupt[]): string {
  return JSON.stringify(
    interrupts.map((i) => [i.key, i.action, i.wakeScreen, i.piercesNightMode, i.severity, i.title]),
  );
}

/**
 * The push hub: holds the sockets, and turns manifest changes into messages.
 *
 * Owns the `ws` server in `noServer` mode — the Node HTTP server hands it an
 * upgrade and it decides, so authentication happens before a socket is ever
 * accepted rather than after. The periodic tick is driven from outside (boot
 * owns the timer) so the hub has no timers of its own to leak in a test.
 */
export class PushHub {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: PushHubDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.now = deps.now ?? ((): number => Date.now());
    this.log = deps.log ?? ((): void => {});
  }

  /**
   * Take a raw HTTP upgrade and either accept a screen or refuse it.
   *
   * The token is checked against the screens exactly as `/d/*` checks it
   * (`authenticateScreenToken`), off the same cookie or bearer. A refusal is a
   * plain 401 written to the socket and a destroy — never a hung connection,
   * and never an accepted socket that turns out to be nobody.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const screen = authenticateScreenToken(this.deps.screens(), {
      authorization: request.headers['authorization'],
      cookie: request.headers['cookie'],
    });
    if (screen === undefined) {
      // A 401 rather than a silent close, so a paired-but-wrong client can tell
      // "not authorised" from "server gone" and stop retrying a dead token.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.log('[push] refused an unauthenticated socket');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws: WebSocket): void => {
      this.register(ws, screen);
    });
  }

  private register(ws: WebSocket, screen: ScreenRow): void {
    const state = this.deps.evaluate(screen);
    const connection: Connection = {
      screenId: screen.id,
      lastEtag: state.etag,
      lastInterruptKey: interruptKey(state.interrupts),
    };
    this.connections.set(ws, connection);

    ws.on('close', () => this.connections.delete(ws));
    // A socket error is a dropped client, not a server fault — forget it and
    // let polling carry the wall until it reconnects.
    ws.on('error', () => this.connections.delete(ws));

    // The current warnings, straight away. A screen coming back from a power
    // cut must not wait a whole tick to learn a storm is overhead — and it must
    // not have to poll first, which is the latency this socket exists to erase.
    this.send(ws, interruptPush(state.interrupts, this.now()));
    this.log(`[push] screen connected (${this.connections.size} live)`);
  }

  /**
   * Push whatever has changed since each screen was last told.
   *
   * Driven by boot's timer. Per connection because a screen in another timezone
   * resolves a night-hours rule differently, so the interrupt set is genuinely
   * per screen — the same reason the manifest is built per screen.
   *
   * A screen whose row has vanished (revoked, or its token rotated so the id no
   * longer resolves) is closed here: the socket outlives the pairing, and this
   * is where the two are reconciled.
   */
  tick(): void {
    if (this.connections.size === 0) return;
    const screens = this.deps.screens();
    const byId = new Map(screens.map((s) => [s.id, s]));
    const at = this.now();

    for (const [ws, connection] of this.connections) {
      const screen = byId.get(connection.screenId);
      if (screen === undefined) {
        // Paired no more. Close rather than keep pushing to a screen the
        // household removed.
        ws.close(1000, 'unpaired');
        this.connections.delete(ws);
        continue;
      }

      let state: PushState;
      try {
        state = this.deps.evaluate(screen);
      } catch {
        // One screen's evaluation failing must not stop the others being told.
        continue;
      }

      const key = interruptKey(state.interrupts);
      if (key !== connection.lastInterruptKey) {
        // The interrupt push is the one that carries `wakeScreen`, and it
        // implies a re-poll too — so a manifest nudge on the same change would
        // be noise. Fire it, and treat the etag as told.
        connection.lastInterruptKey = key;
        connection.lastEtag = state.etag;
        this.send(ws, interruptPush(state.interrupts, at));
        continue;
      }
      if (state.etag !== connection.lastEtag) {
        connection.lastEtag = state.etag;
        this.send(ws, manifestChangedPush(state.etag, at));
      }
    }
  }

  private send(ws: WebSocket, message: unknown): void {
    // A slow or half-closed socket must not throw into the tick loop.
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.connections.delete(ws);
    }
  }

  /** How many screens are connected. For diagnostics and tests. */
  get size(): number {
    return this.connections.size;
  }

  /** Close every socket and the server. Called on shutdown. */
  close(): void {
    for (const ws of this.connections.keys()) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.connections.clear();
    this.wss.close();
  }
}
