import { randomBytes } from 'node:crypto';
import { normaliseShortCode, randomUserCode } from './tokens.js';

/**
 * The device-authorization pairing flow — the "sign a TV into an account"
 * pattern, done LAN-only.
 *
 * The problem this solves is the owner's standing objection
 * ([[pairing-setup-must-be-frictionless]]): no hand-typed addresses, no port
 * hunting, and — the part this file owns — no typing a token on a remote. A
 * screen with no keyboard asks the server to start a flow, shows a short code
 * and a QR, and the household approves it from a phone or the admin page that is
 * *already behind their login*. The token then lands on the screen with nobody
 * typing anything.
 *
 * ## Why this is safe with a friendly 8-character code
 *
 * There are two secrets, and their jobs are deliberately split:
 *
 * - The **device code** is the polling secret held only by the screen. It is 32
 *   bytes of entropy, so nobody on the LAN can guess it and collect somebody
 *   else's freshly-approved token.
 * - The **user code** is the ~38-bit string the household reads off the wall and
 *   approves. Its low entropy is *not* the defence: approval only ever happens
 *   through `/admin/screens/approve`, which sits behind the household session
 *   ([[maverick-wall-code-entry-pairing]]). An attacker on the Wi-Fi has no
 *   session, so they cannot approve any code however many they guess. The user
 *   code just has to be readable across a room and typable on a numeric pad,
 *   which is why it reuses the same unambiguous alphabet as the screen code.
 *
 * ## Why in-memory, per instance
 *
 * A pending pairing lives for minutes and is thrown away the moment it is
 * approved, denied, or expires — there is nothing here worth surviving a
 * restart, and a token that has already reached a screen is in `screens`, which
 * *is* durable. So this is an in-process map, the same call proportionality as
 * the setup token and the pairing-guess rate limiter, and it needs no migration.
 *
 * Rule nine still holds through a restart mid-pairing: the screen's poll starts
 * returning `expired`, the app starts a new flow, and the household approves the
 * fresh code. A lost pending entry is a re-scan, never a brick — and manual host
 * entry plus the existing admin-created pairing code remain as fallbacks that do
 * not touch this file at all.
 *
 * The store is created inside `createApp`, so it is shared by the two routes
 * that need it (the screen's poll and the household's approve) and isolated
 * between test instances — the same reasoning as the auth rate-limit counters.
 */

/** 32 bytes: the device code is the poll secret and must not be guessable. */
const DEVICE_CODE_BYTES = 32;

/**
 * How long a pending pairing lives before the household must start again.
 *
 * Long enough to walk to another room and open the admin page, short enough
 * that an unapproved code is not a standing target for the length of an
 * afternoon. Ten minutes is the same order as the setup token's thirty and far
 * shorter than the screen pairing code's day, because unlike that code this one
 * is polled continuously and consumed the instant it is approved.
 */
export const DEVICE_FLOW_TTL_MS = 10 * 60_000;

/**
 * How often the screen should poll, in seconds, handed back at start.
 *
 * Fixed here so the number the app waits and the number we expect agree. Five
 * seconds is responsive enough that approval feels instant and slow enough that
 * a screen left on the pairing screen still costs the server almost nothing.
 */
export const DEVICE_FLOW_POLL_INTERVAL_SEC = 5;

/**
 * A ceiling on live pending entries, so a script hitting `device-start` cannot
 * grow the map without bound. Far more than a household ever has screens pairing
 * at once; combined with the per-address rate limit on the start route, it caps
 * the memory an unauthenticated caller can occupy. Expired entries are pruned
 * before this is checked, so the limit only bites on genuinely concurrent flows.
 */
const MAX_PENDING = 64;

type DeviceState = 'pending' | 'approved' | 'denied';

interface PendingDevice {
  /** The high-entropy secret the screen polls with. */
  readonly deviceCode: string;
  /** The friendly code the household approves, normalised (no spacing/case). */
  readonly userCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: DeviceState;
  /**
   * The display token to hand back, set only on approval and delivered exactly
   * once. Held in plaintext in memory for the seconds between the household
   * approving and the screen's next poll — the same transient exposure the
   * setup token has, and never written anywhere (rule six).
   */
  token?: string;
  /** The name the household gave the screen at approval, for the poll reply. */
  screenName?: string;
}

/** What `start` hands the screen. */
export interface DeviceFlowStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly pollIntervalSec: number;
}

/** The outcome of a poll, mirroring the device-authorization vocabulary. */
export type DeviceFlowPoll =
  | { readonly status: 'pending' }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }
  | { readonly status: 'approved'; readonly token: string; readonly screenName: string };

/** What the approve page reads to show the household what it is approving. */
export interface DeviceFlowPending {
  readonly userCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: DeviceState;
}

export interface DeviceFlowStore {
  /** Begin a flow. Returns the codes, or `undefined` if the store is full. */
  start(now: number): DeviceFlowStart | undefined;
  /** The screen's poll, by device code. Delivers and consumes an approval. */
  poll(deviceCode: string, now: number): DeviceFlowPoll;
  /** Look up a live pending flow by user code, for the approve page. */
  lookupByUserCode(userCode: string, now: number): DeviceFlowPending | undefined;
  /** Bind a freshly issued token to a user code. False if it cannot be applied. */
  approve(userCode: string, token: string, screenName: string, now: number): boolean;
  /** Refuse a user code. False if there is nothing live to refuse. */
  deny(userCode: string, now: number): boolean;
  /** Test/diagnostic view: how many entries are live right now. */
  size(now: number): number;
}

export function createDeviceFlowStore(): DeviceFlowStore {
  // Keyed by device code (the screen's secret) because that is what every poll
  // arrives with; the user-code lookups a household does are far rarer, so a
  // linear scan for those is fine.
  const pending = new Map<string, PendingDevice>();

  const prune = (now: number): void => {
    for (const [code, entry] of pending) {
      if (now >= entry.expiresAt) pending.delete(code);
    }
  };

  const findByUserCode = (userCode: string, now: number): PendingDevice | undefined => {
    const wanted = normaliseShortCode(userCode);
    if (wanted === '') return undefined;
    for (const entry of pending.values()) {
      if (now < entry.expiresAt && entry.userCode === wanted) return entry;
    }
    return undefined;
  };

  return {
    start(now: number): DeviceFlowStart | undefined {
      prune(now);
      if (pending.size >= MAX_PENDING) return undefined;

      const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url');
      // Retry on the vanishingly unlikely collision with a live code, so two
      // screens pairing at once can never be handed the same one to approve.
      let userCode = normaliseShortCode(randomUserCode());
      for (let tries = 0; tries < 8 && findByUserCode(userCode, now) !== undefined; tries++) {
        userCode = normaliseShortCode(randomUserCode());
      }

      const expiresAt = now + DEVICE_FLOW_TTL_MS;
      pending.set(deviceCode, { deviceCode, userCode, createdAt: now, expiresAt, state: 'pending' });
      return { deviceCode, userCode, expiresAt, pollIntervalSec: DEVICE_FLOW_POLL_INTERVAL_SEC };
    },

    poll(deviceCode: string, now: number): DeviceFlowPoll {
      prune(now);
      const entry = pending.get(deviceCode);
      // An unknown or expired code is the same answer to the screen: start over.
      // Telling them apart would only help someone probing device codes, and the
      // screen's response to either is identical.
      if (entry === undefined) return { status: 'expired' };
      if (entry.state === 'denied') {
        pending.delete(deviceCode);
        return { status: 'denied' };
      }
      if (entry.state === 'approved' && entry.token !== undefined) {
        // Single use: the token is delivered exactly once and the flow is done.
        pending.delete(deviceCode);
        return { status: 'approved', token: entry.token, screenName: entry.screenName ?? '' };
      }
      return { status: 'pending' };
    },

    lookupByUserCode(userCode: string, now: number): DeviceFlowPending | undefined {
      prune(now);
      const entry = findByUserCode(userCode, now);
      if (entry === undefined) return undefined;
      return {
        userCode: entry.userCode,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        state: entry.state,
      };
    },

    approve(userCode: string, token: string, screenName: string, now: number): boolean {
      prune(now);
      const entry = findByUserCode(userCode, now);
      // Only a still-pending flow can be approved: approving an already-approved
      // or denied code is a no-op, so a double submit (the household pressing the
      // button twice, or a scan and a manual entry racing) cannot mint a second
      // screen for one pairing.
      if (entry === undefined || entry.state !== 'pending') return false;
      entry.state = 'approved';
      entry.token = token;
      entry.screenName = screenName;
      return true;
    },

    deny(userCode: string, now: number): boolean {
      prune(now);
      const entry = findByUserCode(userCode, now);
      if (entry === undefined || entry.state !== 'pending') return false;
      entry.state = 'denied';
      return true;
    },

    size(now: number): number {
      prune(now);
      return pending.size;
    },
  };
}
