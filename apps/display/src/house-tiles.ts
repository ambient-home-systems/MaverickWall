/**
 * The Home Assistant widget's `tile` look (plan item P5.3, decision D4), as
 * decisions rather than as nodes.
 *
 * A tile is a reading drawn the way Home Assistant's own tile card draws one:
 * its mark in a filled circle coloured by what the thing is doing, its name,
 * and its state — optionally with when the state last changed and, for a
 * light, a fan or a blind, a bar showing how far along it is. The look is
 * Lovelace's. **The job is not**: a tile shows a state and controls nothing.
 * There is no toggle, no slider and no tap action, because hard rule 12 allows
 * this wall one write to a house and it is a to-do item; and there is no
 * entity picture, because a picture is an address on the household's Home
 * Assistant that the wall would have to fetch, and the wall is never handed
 * one. The widget's help in the editor says both.
 *
 * Pure, with no DOM, for the reason `widget-options.ts`, `ladder.ts` and
 * `weather-looks.ts` are: the renderer builds nodes and does no thinking, and
 * there is no DOM in this package's test suite, so a rule decided inside a
 * `createElement` call is a rule nothing can check.
 */

import type { HouseReadingModel } from './viewmodel.js';

/** Where the mark sits: beside the words (Home Assistant's default) or above them. */
export type TileLayout = 'horizontal' | 'vertical';

/**
 * The words a tile can say, by the name the renderer stamps on each
 * (`data-field`), so the editor can read back which ones a box kept.
 *
 * The mark and its circle are not a word and are never given up: they are
 * what makes a tile a tile, and the circle's colour is the state for anybody
 * too far away to read it.
 */
export type TileWord = 'name' | 'state' | 'changed';

/**
 * The words in the order they are **kept** when a tile is too narrow for all
 * of them — the state first, which is `HOUSE_TIERS`' argument one look along:
 * a reading that has given up its state is a tile saying "Kitchen" and not
 * "19.4 °C", and for a thermometer the circle's colour says nothing either.
 * Then the name, then when it changed, which is a detail of the state.
 */
export const TILE_KEEP: readonly TileWord[] = ['state', 'name', 'changed'];

/** A tile widget's options, each read the way its absence is documented. */
export interface TileOptions {
  readonly layout: TileLayout;
  /** `hideState`: the tile is its mark, its colour and its name. */
  readonly hideState: boolean;
  /** `showChanged`: "· 5 min ago" on the state line. */
  readonly showChanged: boolean;
  /** `showBar`: the read-only bar under a reading that has a level. */
  readonly showBar: boolean;
}

function record(config: unknown): Readonly<Record<string, unknown>> {
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/**
 * What a stored config asks of a tile. Every absence is the default the schema
 * states, and anything that is not the exact value is that default too — a
 * config from a server one release ahead costs a tile its option, never the
 * tile.
 */
export function tileOptions(config?: unknown): TileOptions {
  const c = record(config);
  return {
    layout: c['tileLayout'] === 'vertical' ? 'vertical' : 'horizontal',
    hideState: c['hideState'] === true,
    showChanged: c['showChanged'] === true,
    showBar: c['showBar'] === true,
  };
}

/**
 * The words a tile says when its box has room for all of them, in the order
 * they are drawn: the name over the state, and when it changed riding on the
 * state's own line.
 *
 * "When it changed" belongs to the state line, so a tile with its state hidden
 * says neither — "· 5 min ago" under a name is five minutes since what?
 */
export function tileWords(options: TileOptions): readonly TileWord[] {
  if (options.hideState) return ['name'];
  return options.showChanged ? ['name', 'state', 'changed'] : ['name', 'state'];
}

/** How a tile is coloured: the server's tone, or idle for anything else. */
export type TileTone = 'active' | 'alert' | 'idle';

export function tileTone(reading: HouseReadingModel): TileTone {
  return reading.tone === 'active' || reading.tone === 'alert' ? reading.tone : 'idle';
}

/**
 * "5 min ago", from when the state changed and the wall's corrected clock —
 * or `undefined` when Home Assistant did not say, so the line says nothing
 * rather than a time nobody knows.
 *
 * Short where `describeAge` is long, because it shares a line with the state
 * in a box a household dragged to hold six of them; and **floored**, never
 * rounded, for `describeAge`'s own reason: rounding turns thirty seconds into
 * "1 min ago", a wall claiming a door has been open longer than it has. A time
 * ahead of the wall's clock — the house's clock and the wall's disagreeing by
 * a few seconds — is "just now" rather than a negative number.
 *
 * Worked out on every draw rather than carried: the manifest holds the instant,
 * which does not move while the state does not, and the wall redraws every
 * fifteen seconds, so the words keep up without a single new document.
 */
export function changedWords(changedAt: number | undefined, now: number): string | undefined {
  if (changedAt === undefined || !Number.isFinite(changedAt) || !Number.isFinite(now)) return undefined;
  const minutes = Math.floor(Math.max(0, now - changedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * How much of the bar a reading fills, as a percentage — or `undefined` when
 * it has no level, and then no bar is drawn for it at all. Refused rather than
 * clamped, the model's own rule: a level outside 0-100 is not one.
 */
export function barPercent(reading: HouseReadingModel): number | undefined {
  const level = reading.level;
  return level !== undefined && level >= 0 && level <= 100 ? level : undefined;
}

/**
 * Whether the bar is drawn, given how many tiles the box shows with it and
 * without it — both counted off a drawn box, never divided out of a height.
 *
 * **A bar never costs a tile.** It is a picture of a number the state line
 * already says ("On · 60%"), so it is an annotation of the reading — and the
 * rule this wall already keeps for annotations is that nothing annotating an
 * event costs it a row. So the bar is drawn only where the box shows as many
 * tiles with it as it would without it; a box with room for a row of plain
 * tiles and not a row of barred ones keeps every tile and gives up the bars.
 *
 * A comparison of two counts, and deliberately nothing cleverer: the first
 * version divided the box by one row's height with and without a bar, and a
 * row is not one height — a name that wraps, or a bar under the lamp and none
 * under the thermometer beside it, makes the next row taller than the first —
 * so the arithmetic kept bars the belt then took away with their tiles.
 */
export function barKeepsEveryTile(shownWithBar: number, shownWithoutBar: number): boolean {
  return shownWithBar >= shownWithoutBar;
}
