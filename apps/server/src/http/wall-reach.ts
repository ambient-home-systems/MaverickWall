import type { SqliteDatabase } from '../db/open.js';
import {
  keepWidgetsWithSomethingToSay,
  readingEntityIds,
  type HouseholdSetUp,
} from '../api/manifest.js';
import {
  effectiveDisplay,
  livePanelCanvasOwner,
  readAdminScreens,
  readHousehold,
  readLayoutSlots,
  readLayoutWidgets,
  type AdminScreenRow,
} from '../api/queries.js';
import { epaperOrientation } from '../epaper/frame.js';
import { withInk } from '../epaper/honours.js';
import { tag } from './components.js';

/**
 * Which walls draw what (P1.3).
 *
 * "Add to the wall" watched a Home Assistant entity and put it on no wall at
 * all: a reading is drawn by a Home Assistant *widget*, and Classic, which
 * every wall starts on, has none. The Store's recipe install said the same
 * about a module that only an External widget draws. So the screens that add
 * those things now say where each one actually is, and this is the one answer
 * both of them ask — worked out from the rows the renderers draw from rather
 * than guessed from the widget types a wall happens to hold.
 *
 * **Every canvas a wall can draw, and the widgets it would draw on each.** A
 * browser wall draws its portrait and its landscape canvas and every named
 * layout its schedule swaps in (RFC 014 §5.2), so all of them count — a reading
 * on the evening layout is on the wall every evening. An e-paper panel draws
 * one canvas, in the one orientation it is hung, from its own rows or from the
 * wall it follows, and never a named layout; a panel on its built-in view
 * draws no widgets at all. That is `livePanelCanvasOwner` and
 * `epaperOrientation`, the two the frame route asks, and the ink lane laid over
 * each widget the way the panel lays it (`withInk`), because a panel's
 * `readings` override is the list it actually draws.
 *
 * **What is drawn is `keepWidgetsWithSomethingToSay`'s answer**, the same
 * function the manifest and the frame go through, so a widget the wall leaves
 * out is not counted and a fallback standing in for one is. The caller passes
 * the household's set-up, and may widen it: the Home Assistant screen asks
 * "would this wall draw readings", which must not turn on whether any reading
 * is watched yet.
 *
 * Revoked walls are left out — they are on nobody's wall.
 */

/** A widget a wall draws, with the config it is drawn by. */
export interface DrawnWidget {
  readonly type: string;
  readonly config: unknown;
}

export interface WallDrawing {
  readonly id: string;
  readonly name: string;
  /** Where the household arranges this wall's widgets: a wall's Layout, a panel's designer. */
  readonly layoutHref: string;
  /** Every widget drawn on any canvas this wall can draw. */
  readonly widgets: readonly DrawnWidget[];
}

/** Where a wall's widgets are arranged — the split P1.4's Overview links make. */
export function layoutHrefOf(screen: { readonly id: string; readonly kind: string }): string {
  return screen.kind === 'epaper'
    ? `admin/epaper/${encodeURIComponent(screen.id)}/design`
    : `admin/walls/${encodeURIComponent(screen.id)}#layout`;
}

function drawnOn(
  db: SqliteDatabase,
  household: ReturnType<typeof readHousehold>,
  screen: AdminScreenRow,
  setUp: HouseholdSetUp,
): DrawnWidget[] {
  const drawn: DrawnWidget[] = [];
  const add = (rows: ReturnType<typeof readLayoutWidgets>, ink: boolean): void => {
    for (const widget of keepWidgetsWithSomethingToSay(rows, setUp)) {
      const config =
        ink && typeof widget.config === 'object' && widget.config !== null
          ? withInk(widget.config as Record<string, unknown>)
          : widget.config;
      drawn.push({ type: widget.type, config });
    }
  };

  if (screen.kind === 'epaper') {
    const owner = livePanelCanvasOwner(db, screen);
    if (owner === undefined) return drawn;
    add(readLayoutWidgets(db, owner, epaperOrientation(screen)), true);
    return drawn;
  }

  const { layoutOwner } = effectiveDisplay(household, screen);
  for (const slot of [null, ...readLayoutSlots(db, layoutOwner)]) {
    add(readLayoutWidgets(db, layoutOwner, 'portrait', slot), false);
    add(readLayoutWidgets(db, layoutOwner, 'landscape', slot), false);
  }
  return drawn;
}

/** Every wall that is still paired, with everything it draws. */
export function wallsAndWhatTheyDraw(db: SqliteDatabase, setUp: HouseholdSetUp): WallDrawing[] {
  const household = readHousehold(db);
  return readAdminScreens(db)
    .filter((screen) => screen.revokedAt === null)
    .map((screen) => ({
      id: screen.id,
      name: screen.name,
      layoutHref: layoutHrefOf(screen),
      widgets: drawnOn(db, household, screen, setUp),
    }));
}

/**
 * The walls that draw a given Home Assistant reading.
 *
 * A Home Assistant widget draws a reading when its `readings` is empty — all
 * of them, the default — or names it: by entity id, which is what the editor
 * writes, or by the label a widget saved before it did, read exactly as the
 * wall reads it (`readingEntityIds`). Not asked: how many of them fit in the
 * box, which is density rather than whether the reading is on that wall.
 */
export function wallsShowingReading(
  walls: readonly WallDrawing[],
  entityId: string,
  choices: readonly { readonly id: string; readonly name: string }[],
): WallDrawing[] {
  return walls.filter((wall) =>
    wall.widgets.some((widget) => {
      if (widget.type !== 'homeassistant') return false;
      const entries = readingEntityIds(readingsOf(widget.config), choices) ?? [];
      return entries.length === 0 || entries.includes(entityId);
    }),
  );
}

/** Whether any wall draws a Home Assistant widget at all. */
export function anyWallShowsReadings(walls: readonly WallDrawing[]): boolean {
  return walls.some((wall) => wall.widgets.some((widget) => widget.type === 'homeassistant'));
}

/** The walls that draw a given installed module: an External widget naming it. */
export function wallsShowingModule(walls: readonly WallDrawing[], moduleId: string): WallDrawing[] {
  return walls.filter((wall) =>
    wall.widgets.some(
      (widget) =>
        widget.type === 'external' &&
        typeof widget.config === 'object' &&
        widget.config !== null &&
        (widget.config as Record<string, unknown>)['module'] === moduleId,
    ),
  );
}

function readingsOf(config: unknown): unknown {
  return typeof config === 'object' && config !== null
    ? (config as Record<string, unknown>)['readings']
    : undefined;
}

/**
 * The sentence a row carries: "On: Kitchen, Hall", or that it is on none.
 *
 * Names rather than a count, because the question somebody is answering when
 * they read it is "is it on the kitchen one", and in the order the walls list
 * draws them.
 */
export function shownOnSentence(walls: readonly WallDrawing[]): string {
  return walls.length === 0 ? 'Not on any wall yet' : `On: ${walls.map((wall) => wall.name).join(', ')}`;
}

/**
 * That sentence as the row's state: a `tag`, because where a thing is shown is
 * a state and a state is a word with its own element; `warn` when it is on no
 * wall, because that is the one case with something to go and do.
 */
export function shownOnTag(walls: readonly WallDrawing[]): string {
  return tag(shownOnSentence(walls), walls.length === 0 ? 'warn' : 'neutral');
}
