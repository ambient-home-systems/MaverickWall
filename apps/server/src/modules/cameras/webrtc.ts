import { randomBytes } from 'node:crypto';
import type { SocketStep, SubscribeOutcome } from '@maverick-wall/core';
import { parseJsonOr, z } from '../../validation.js';
import { clean } from '../weather/alerts.js';

/**
 * A camera shown over WebRTC (Hard rule 12's exception, amended 2026-10-14).
 *
 * WebRTC sends the video straight from Home Assistant's media server (go2rtc)
 * to the wall's browser, so it is the one camera path where the picture does
 * not pass through this server. **The signalling does.** The wall hands us its
 * offer; we open Home Assistant's WebSocket API with the token, send
 * `camera/webrtc/offer` for the entity the handle names, and hand the wall back
 * the answer and the media server's connection candidates — and nothing else.
 * So the wall learns the address and ports go2rtc offers for that one stream,
 * which is what the amended rule permits, and never Home Assistant's URL, the
 * entity id or the token, and it cannot call a single service with what it
 * was given.
 *
 * **The socket is the session.** Home Assistant ends a WebRTC session when the
 * WebSocket that opened it closes, so it is held for as long as the wall
 * watches: the wall polls for late candidates and that poll is its heartbeat;
 * a session nobody has polled for `idleMs` is closed, and so is one past
 * `maxDurationMs`, and the route closes one whose wall or camera stops passing
 * the gate. The wall gathers its own candidates before it sends the offer, so
 * nothing but the offer goes from here to the house.
 *
 * A camera that does not offer WebRTC is refused by Home Assistant, and that
 * refusal is the answer: the wall falls back to the MJPEG stream (M6.2).
 */

/** The one command this file sends after the handshake, beside the keepalive `ping`. */
export const HA_WEBRTC_COMMANDS = ['camera/webrtc/offer', 'ping'] as const;

export interface WebrtcLimits {
  /** How long Home Assistant has to answer an offer. */
  readonly answerMs: number;
  /** A session the wall has not polled for this long is over. */
  readonly idleMs: number;
  /** No session outlives this; the wall starts another. */
  readonly maxDurationMs: number;
  /** Sessions one wall may hold. */
  readonly perScreen: number;
  /** Sessions the house may hold. */
  readonly house: number;
  /** How often the held socket is pinged so it is not idle. */
  readonly pingMs: number;
}

export const WEBRTC_LIMITS: WebrtcLimits = {
  answerMs: 10_000,
  idleMs: 20_000,
  maxDurationMs: 60 * 60_000,
  perScreen: 4,
  house: 8,
  pingMs: 30_000,
};

/** The most an SDP may be, either way. A real one is a few kilobytes. */
export const MAX_SDP = 64 * 1024;
/** The most candidates one session hands a wall. */
export const MAX_CANDIDATES = 64;

export interface Candidate {
  readonly candidate: string;
  readonly sdpMid?: string;
  readonly sdpMLineIndex?: number;
}

/** An SDP is text that starts `v=0`, carries no NUL, and is not enormous. */
export function isSdp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SDP && value.startsWith('v=0') && !value.includes('\u0000');
}

const candidateShape = z.union([
  z.string(),
  z.looseObject({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdp_mid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    sdp_m_line_index: z.number().nullable().optional(),
  }),
]);

/**
 * A candidate from Home Assistant, in the one shape the wall reads, or
 * nothing. Both spellings are read because the field names have moved between
 * releases; the candidate line itself is held to what a candidate line is.
 */
export function candidateFrom(raw: unknown): Candidate | undefined {
  const shaped = candidateShape.safeParse(raw);
  if (!shaped.success) return undefined;
  const value = shaped.data;
  const line = typeof value === 'string' ? value : value.candidate;
  // An empty line is end-of-candidates: nothing to hand on.
  if (line.length === 0 || line.length > 1024 || !/^(a=)?candidate:[\x20-\x7e]+$/.test(line)) return undefined;
  if (typeof value === 'string') return { candidate: line.replace(/^a=/, '') };
  const mid = value.sdpMid ?? value.sdp_mid ?? undefined;
  const index = value.sdpMLineIndex ?? value.sdp_m_line_index ?? undefined;
  return {
    candidate: line.replace(/^a=/, ''),
    ...(typeof mid === 'string' && mid.length <= 64 && /^[\x21-\x7e]*$/.test(mid) ? { sdpMid: mid } : {}),
    ...(typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 64 ? { sdpMLineIndex: index } : {}),
  };
}

const frame = z.looseObject({
  type: z.string(),
  id: z.number().optional(),
  success: z.boolean().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  event: z.looseObject({ type: z.string() }).optional(),
});

/** Opens Home Assistant's WebSocket for one session; the route supplies the connection and the guard. */
export type OpenSocket = (
  converse: (message: string) => SocketStep,
  idleTimeoutMs: number,
) => Promise<SubscribeOutcome | undefined>;

export type StartResult =
  | { readonly ok: true; readonly session: string; readonly answer: string; readonly candidates: readonly Candidate[] }
  | { readonly ok: false; readonly status: 409 | 502 | 503; readonly message: string };

export interface PollResult {
  readonly candidates: readonly Candidate[];
  readonly ended: boolean;
}

interface Session {
  readonly id: string;
  readonly screenId: string;
  readonly handle: string;
  readonly startedAt: number;
  lastPolledAt: number;
  readonly candidates: Candidate[];
  ended: boolean;
  close(): void;
}

export interface WebrtcSessions {
  start(screenId: string, handle: string, entityId: string, offer: string, token: string): Promise<StartResult>;
  /** Late candidates after the `after`th, and whether the session is over; nothing for a session that is not this wall's. */
  poll(screenId: string, session: string, after: number): PollResult | undefined;
  /** The wall has stopped watching. */
  end(screenId: string, session: string): void;
  /** Close every session whose wall and camera no longer pass `allowed`, and every idle or old one. */
  sweep(allowed: (screenId: string, handle: string) => boolean): void;
  /** How many sessions are open, for the tests. */
  size(): number;
  closeAll(): void;
}

export interface WebrtcDeps {
  readonly open: OpenSocket;
  readonly limits?: Partial<WebrtcLimits>;
  readonly now?: () => number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;

export function createWebrtcSessions(deps: WebrtcDeps): WebrtcSessions {
  const limits: WebrtcLimits = { ...WEBRTC_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const count = (screenId: string): number => [...sessions.values()].filter((s) => s.screenId === screenId).length;

  return {
    async start(screenId, handle, entityId, offer, token): Promise<StartResult> {
      if (!isSdp(offer)) return { ok: false, status: 409, message: 'That offer is not one a browser makes.' };
      if (count(screenId) >= limits.perScreen) {
        return { ok: false, status: 503, message: 'This wall is already showing as many live cameras as it can.' };
      }
      if (sessions.size >= limits.house) {
        return { ok: false, status: 503, message: 'This house is already showing as many live cameras as it can at once.' };
      }

      const candidates: Candidate[] = [];
      let answer: string | undefined;
      let refusal: string | undefined;
      let settle: (() => void) | undefined;
      const answered = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let offered = 0;
      let nextId = 1;
      const done = (): void => settle?.();

      const outcome = await deps.open((text) => {
        const shaped = frame.safeParse(parseJsonOr(z.unknown(), text, undefined));
        if (!shaped.success) {
          refusal = 'Home Assistant sent something unreadable.';
          done();
          return { fail: refusal };
        }
        const message = shaped.data;
        if (message.type === 'auth_required') return { send: [JSON.stringify({ type: 'auth', access_token: token })] };
        if (message.type === 'auth_invalid') {
          refusal = 'Home Assistant did not accept the token.';
          done();
          return { fail: refusal };
        }
        if (message.type === 'auth_ok') {
          offered = nextId++;
          return { send: [JSON.stringify({ id: offered, type: 'camera/webrtc/offer', entity_id: entityId, offer })] };
        }
        if (message.type === 'result' && message.id === offered && message.success !== true) {
          const said = message.error?.message === undefined ? null : clean(message.error.message, 200);
          refusal = `This camera does not offer WebRTC through Home Assistant${said === null ? '' : `: ${said}`}.`;
          done();
          return { fail: refusal };
        }
        if (message.type === 'event' && message.id === offered && message.event !== undefined) {
          const event = message.event as Record<string, unknown>;
          if (event['type'] === 'answer') {
            if (isSdp(event['answer'])) answer = event['answer'];
            else refusal = 'Home Assistant answered with something that is not a session.';
            done();
          } else if (event['type'] === 'candidate') {
            const candidate = candidateFrom(event['candidate']);
            if (candidate !== undefined && candidates.length < MAX_CANDIDATES) candidates.push(candidate);
          } else if (event['type'] === 'error') {
            const said = typeof event['message'] === 'string' ? clean(event['message'], 200) : null;
            refusal = `The camera would not start${said === null ? '' : `: ${said}`}.`;
            done();
            return { fail: refusal };
          }
        }
        // `session`, a pong, or an answer to nothing we asked.
        return { send: [] };
      }, limits.pingMs * 3);

      if (outcome === undefined) return { ok: false, status: 503, message: 'Home Assistant is not connected.' };
      if (outcome.status !== 'ok') return { ok: false, status: 502, message: 'Home Assistant could not be reached.' };

      void outcome.ended.then(() => done());
      const timer = setTimeout(done, limits.answerMs);
      timer.unref?.();
      await answered;
      clearTimeout(timer);

      if (answer === undefined) {
        outcome.close();
        return { ok: false, status: refusal === undefined ? 502 : 409, message: refusal ?? 'Home Assistant did not answer in time.' };
      }

      const id = randomBytes(16).toString('base64url');
      const ping = setInterval(() => outcome.send(JSON.stringify({ id: nextId++, type: 'ping' })), limits.pingMs);
      ping.unref?.();
      const session: Session = {
        id,
        screenId,
        handle,
        startedAt: now(),
        lastPolledAt: now(),
        candidates,
        ended: false,
        close(): void {
          clearInterval(ping);
          session.ended = true;
          outcome.close();
        },
      };
      void outcome.ended.then(() => {
        clearInterval(ping);
        session.ended = true;
      });
      sessions.set(id, session);
      return { ok: true, session: id, answer, candidates: [...candidates] };
    },

    poll(screenId, id, after): PollResult | undefined {
      if (!SESSION_ID.test(id)) return undefined;
      const session = sessions.get(id);
      if (session === undefined || session.screenId !== screenId) return undefined;
      session.lastPolledAt = now();
      const from = Number.isInteger(after) && after >= 0 ? after : 0;
      const result = { candidates: session.candidates.slice(from), ended: session.ended };
      if (session.ended) sessions.delete(id);
      return result;
    },

    end(screenId, id): void {
      const session = sessions.get(id);
      if (session === undefined || session.screenId !== screenId) return;
      session.close();
      sessions.delete(id);
    },

    sweep(allowed): void {
      const at = now();
      for (const [id, session] of sessions) {
        const over =
          session.ended ||
          at - session.lastPolledAt > limits.idleMs ||
          at - session.startedAt > limits.maxDurationMs ||
          !allowed(session.screenId, session.handle);
        if (!over) continue;
        session.close();
        // An ended session is kept one poll longer only if the wall is still
        // polling, so it can learn it ended; anything else goes now.
        if (at - session.lastPolledAt > limits.idleMs || !allowed(session.screenId, session.handle)) sessions.delete(id);
      }
    },

    size: () => sessions.size,

    closeAll(): void {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}
