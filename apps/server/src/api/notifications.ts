import { createHash } from 'node:crypto';
import type { Interrupt, InterruptRule } from '@maverick-wall/core';

/**
 * The Notifications widget's data (plan item M6.11): alert rules a household
 * set to say what they found as a **tile** rather than over the wall, and Home
 * Assistant's own persistent notifications.
 *
 * Pure. The tiles are the interrupt evaluator's own answer — the rule matched,
 * dwelt, was not acknowledged — with the ones whose action is `tile` taken out
 * of the banners and handed here, so a tile rule is everything a banner rule
 * is, said quietly. What leaves for the wall is words and a handle: never the
 * signal's key, which for a Home Assistant rule is an entity id (rule 12).
 */

/** One tile as the wall draws it. */
export interface NotificationTile {
  /** `tile:` and a hash of the rule and the signal — what a wall acknowledges it by. */
  readonly key: string;
  /** The household's own sentence for the rule. */
  readonly title: string;
  /** What it is about and what it is doing: "Freezer door · Open". */
  readonly detail?: string;
  /** `alert` for a severe or extreme signal; otherwise quiet. */
  readonly tone?: 'alert';
  /** Whether the rule said it may be cleared, and so whether a wall offers OK. */
  readonly dismissible: boolean;
}

/** One of Home Assistant's persistent notifications, as the wall draws it. */
export interface HaNotification {
  readonly key: string;
  readonly title?: string;
  readonly message: string;
  /** When Home Assistant made it, epoch ms. */
  readonly createdAt?: number;
}

/** The panel under `notifications` in the manifest: each list spread only when it has something. */
export interface NotificationsPanel {
  readonly tiles?: readonly NotificationTile[];
  readonly ha?: readonly HaNotification[];
}

export const NOTIFICATIONS_BLOCK = 'notifications';

/** A tile's handle: stable for one rule and one signal, and naming neither. */
export function tileHandle(ruleId: string, signalKey: string): string {
  return `tile:${createHash('sha256').update(`tile:${ruleId}\u0000${signalKey}`).digest('hex').slice(0, 24)}`;
}

/** The interrupts a wall draws over itself — everything but the tiles. */
export function bannersOf(active: readonly Interrupt[]): Interrupt[] {
  return active.filter((interrupt) => interrupt.action !== 'tile');
}

/** The tiles, in the evaluator's own order (loudest first), with the rule's own words. */
export function tilesOf(active: readonly Interrupt[], rules: readonly InterruptRule[]): NotificationTile[] {
  const names = new Map(rules.map((rule) => [rule.id, rule.name]));
  return active
    .filter((interrupt) => interrupt.action === 'tile')
    .map((interrupt) => {
      const name = names.get(interrupt.ruleId);
      const detail = interrupt.headline === undefined ? interrupt.title : `${interrupt.title} · ${interrupt.headline}`;
      const title = name === undefined || name.trim() === '' ? interrupt.title : name;
      return {
        key: tileHandle(interrupt.ruleId, interrupt.key),
        title,
        ...(detail === title ? {} : { detail }),
        ...(interrupt.severity === 'Extreme' || interrupt.severity === 'Severe' ? { tone: 'alert' as const } : {}),
        dismissible: interrupt.dismissible,
      };
    });
}

/** The tile a handle names among those firing, with what is needed to acknowledge it. */
export function tileFor(
  handle: string,
  active: readonly Interrupt[],
): { readonly ruleId: string; readonly signalKey: string } | undefined {
  const found = active.find(
    (interrupt) => interrupt.action === 'tile' && tileHandle(interrupt.ruleId, interrupt.key) === handle,
  );
  return found === undefined ? undefined : { ruleId: found.ruleId, signalKey: found.key };
}
