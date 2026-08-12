import type { Interrupt } from '@maverick-wall/core';

/**
 * The push message contract.
 *
 * There is no WebSocket server yet — the display polls, and the manifest is
 * what carries interrupts today. This file exists anyway, and deliberately:
 * the Android app needs `wakeScreen` on the wire, and adding a field to a
 * message after an app has shipped means a version of that app in somebody's
 * hallway that will never wake for a tornado warning until they update it.
 *
 * So the shape is fixed now, built from the same `Interrupt` the manifest
 * carries, and tested. When the socket lands it sends these; nothing about the
 * app has to change.
 *
 * **Web clients ignore `wakeScreen`.** A browser cannot turn a screen on, and
 * a tab pretending otherwise would be a wall that looks like it woke and did
 * not. The Android app holds the wake lock and acts on it.
 */

export const PUSH_PROTOCOL_VERSION = 1;

export type PushMessage = InterruptPush | ManifestChangedPush;

export interface InterruptPush {
  readonly type: 'INTERRUPT_PUSH';
  readonly protocol: number;
  /** Server time, so a client with a drifting clock can still order these. */
  readonly sentAt: number;
  /**
   * What is in force, loudest first — the whole set, not a delta.
   *
   * A client that missed a message must not be left holding a warning that has
   * been cancelled, and reconciling deltas across a reconnect is how that
   * happens. Sending the set makes a dropped message cost latency and nothing
   * else, which on a wall is the right trade every time.
   */
  readonly interrupts: readonly Interrupt[];
  /**
   * True when anything in this set asked for a screen that has gone dark.
   *
   * Hoisted out of the list so a client acts on one boolean rather than
   * scanning — and so the field is unmissable to whoever writes the app.
   *
   * Straight from the action, and deliberately *not* also gated on
   * `piercesNightMode`. Those are different questions: waking is about a screen
   * that is dark for any reason, and piercing night mode is about the hours a
   * household said to stay quiet. Anding them here made
   * `takeover_and_wake` with `piercesNightMode: false` a silent no-op, which is
   * a combination somebody could set and never work out. Both fields travel on
   * every interrupt, so an app that wants to respect night hours has what it
   * needs without this one lying about what was asked for.
   */
  readonly wakeScreen: boolean;
}

export interface ManifestChangedPush {
  readonly type: 'MANIFEST_CHANGED';
  readonly protocol: number;
  readonly sentAt: number;
  /** The client re-polls if this differs from what it holds. */
  readonly etag: string;
}

/** Build the interrupt message. */
export function interruptPush(interrupts: readonly Interrupt[], sentAt: number): InterruptPush {
  return {
    type: 'INTERRUPT_PUSH',
    protocol: PUSH_PROTOCOL_VERSION,
    sentAt,
    interrupts,
    wakeScreen: interrupts.some((interrupt) => interrupt.wakeScreen),
  };
}

/** Build the manifest-changed nudge. */
export function manifestChangedPush(etag: string, sentAt: number): ManifestChangedPush {
  return {
    type: 'MANIFEST_CHANGED',
    protocol: PUSH_PROTOCOL_VERSION,
    sentAt,
    etag,
  };
}
