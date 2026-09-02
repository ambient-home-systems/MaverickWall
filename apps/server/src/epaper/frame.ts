/**
 * A screen's manifest, turned into a packed e-paper frame and an ETag (RFC 006).
 *
 * This is the seam the endpoint calls: manifest in, framebuffer plus ETag out.
 * It renders in the panel's visual orientation, turns the raster to the panel's
 * native scan order, and derives the ETag from the *inputs* so a `304` costs no
 * rendering.
 *
 * The ETag is the load-bearing detail. `manifestEtag` deliberately drops
 * `generatedAt`, which is right for the browser wall but would freeze an
 * e-paper frame that should still roll over at local midnight — so the civil
 * date (`model.today`) is in the preimage, and so is a renderer version that
 * MUST be bumped whenever the drawing changes, or panels keep the old frame for
 * months. Same "a version that lies" failure the migration journal guards.
 *
 * ## The tier, and why it is in the preimage
 *
 * `render.ts` states the partial-refresh contract: every drawn region is a
 * rectangle whose position is a function of **(panel size, tier)** only, so two
 * frames at the same panel size and tier differ in nothing but the ink inside
 * their rectangles and everything between them is safe to push as a partial
 * refresh. A geometry change must therefore force exactly *one* full refresh —
 * and the ETag is the only handle a dumb panel has on "has the geometry
 * changed?".
 *
 * So the resolved tier is in the preimage. Today it is a pure function of the
 * panel's short side, which is in the preimage already, so this adds no churn —
 * a household who never touches anything keeps every stored ETag — and that is
 * asserted rather than assumed. What it buys is that the contract is hashed
 * over the thing it is *stated* over rather than over something that happens to
 * imply it: the day the tier stops being a function of pixels alone (a measured
 * panel, a grade, a moved table), the ETag moves with it and no panel
 * composites two layouts onto one sheet.
 */
import { createHash } from 'node:crypto';

import { manifestEtag, type Manifest } from '../api/manifest.js';

import { Framebuffer, rotate } from './framebuffer.js';
import { typeTierFor } from './type-tiers.js';
import { renderEpaper } from './render.js';
import { buildEpaperModel } from './viewmodel.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from './widgets.js';

/**
 * Bump when the drawing changes in any way that alters pixels. It is in the
 * ETag preimage, so forgetting to bump it means every paired panel silently
 * keeps drawing the previous version until its manifest content happens to
 * change.
 *
 * 2: the ink lane, and the empty-state notes sized to their box rather than to
 * their own sentence — which is a pixel change on any panel whose canvas has a
 * narrow column.
 *
 * 3: the month grid's default cell treatment. `cellEvents` unset used to mean
 * dots and now means names, on the wall and therefore here — so a panel whose
 * calendar widget never named the setting draws event titles where it drew
 * marks. No code in this file changed, which is exactly why this bump is easy
 * to miss: the pixels moved because the *meaning of an absent value* did.
 *
 * 4: the month grid's three content rules, following the wall. A multi-day
 * event is one bar across its days instead of the same words repeated in
 * every square; the "+N" shares the last name's line instead of taking one of
 * its own, and is not drawn at all by a cell that can name nothing; and a
 * density mark under the numeral says how busy a day is with no legible text.
 * Every cell in the grid moves, on every panel.
 *
 * 5: the layout is proportional to the panel (`epaper/metrics.ts`), for the
 * built-in frame *and* the free-form widgets. Every absolute pixel the frame
 * was drawn with — the 16px margin, the 54px header, the 34px agenda row, the
 * 26px week head, the 34px pill threshold, the six agenda rows, the four cell
 * names, and on the widget side an 8px inset, a title bar with 8px type in it,
 * 24px to-do rows, 22px chore rows and a dozen calls capping ordinary widget
 * text at 16px — was tuned by looking at one 800×480 Seeed panel and applied
 * to a range running 640×384 to 1872×1404. A 13.3" panel drew 714px of white
 * below its last row and a `notes` widget 15% of the ink density it drew on a
 * 7.5" one. The 800×480 frames are byte-identical apart from a module panel
 * counting its rows at the line height it draws them with, which is one more
 * reading in a short box — and that alone is a pixel change, so the bump is
 * not optional even for the panel nothing else moved on. Two bumps on the
 * branch (the frame, then the widgets) collapse to this one, because they
 * reach a household together and no panel ever served the state between them.
 *
 * 6: density tiers (`epaper/tiers.ts`, the wall's table transcribed). A month
 * cell reads its own inner box in characters of the type it would draw, and
 * takes a *form* — how many names, how many lines each may wrap to, whether a
 * time is drawn beside one, how much of a weekday head there is room for —
 * rather than drawing everything and truncating. `pillMinCell`/`pillMinWidth`
 * are what it replaces, and the width half of that pair was 32px: three and a
 * half characters of this font, so on every panel in the range a household who
 * asked for labelled cells got "Denti" and "Assem" — a truncation this
 * project's own rule calls a different string rather than a shortened title,
 * and one the wall stopped drawing when flat names replaced pills. Measured,
 * the built-in layout's cells are 3.8 to 9.7 characters wide.
 *
 * It also closes a divergence rather than only a fault: at 800x480 the wall
 * draws no names in a cell of that size and the panel drew four. One stored
 * value, two renderers, two answers — which is the shape of `shifts[0]`,
 * `display_mode`, `cellEvents` and `mode`, and the fourth time the cure has
 * been to resolve it once and hand over the answer.
 *
 * Every panel that draws a month grid moves. A cell that can name nothing
 * draws its density mark, which was already there; a multi-day bar keeps its
 * words wherever the bar's *own* width can hold them, which on a 7.5" panel is
 * the only name its grid has ever had.
 *
 * 7: first-party glyphs (`epaper/glyphs.ts`). The forecast strip and the house
 * readings draw a picture where they have drawn nothing since they were
 * written. The rung was always in the ladder; what filled it was an emoji the
 * modules chose, and `asciiTitle` drops every code point above 0x7E, so a
 * household who put weather on a panel got a column of temperatures with a hole
 * in it and `icon_state` — whose whole name is the mark and the state — drew no
 * mark. The vocabulary is first-party and closed, the cells are drawn at the
 * size they are used rather than scaled down from the wall's paths, and a key
 * this panel does not know draws nothing at all.
 *
 * Every panel with a forecast or a house reading on it moves; a panel with
 * neither is byte-identical.
 *
 * 8: three bitmap faces, chosen by tier (`font-12x16.ts`, `font-16x24.ts`,
 * `type-tiers.ts`). The panel had one 8x8 alphabet at integer scales, so a
 * bigger panel got bigger type by multiplying a square and the only sizes in
 * the whole 3.7x range were 8, 16, 24 and 32 pixels. The role carrying a month
 * cell's event names is `round(body / 2)`, which is **2 on a 10.3" panel and 2
 * on a 13.3" one** — 12.6 arc-minutes at one panel's read distance and 9.9 at
 * the other's, so the larger, further screen drew it *smaller*. The two new
 * faces are drawn at the size they are used, keep font8x8's own cap height and
 * stroke ratio at every rung, and reach it in 28-37% less advance: measured,
 * the agenda's title column goes from 11, 15, 17, 18, 18 and 29 characters to
 * 17, 23, 29, 28, 27 and 43 across the six supported sizes, and a 13.3" panel's
 * cell names go from 16px to 24px. Every glyph on every panel moves.
 *
 * It also brings the **grade**: reversed type — the header band, today's cell,
 * a span bar's label — is drawn one stroke heavier at the same advance, which
 * is the browser wall's `--f-grade` on a bitmap. No metric moves with it, by
 * construction, because a metric change is a reflow.
 */
export const EPAPER_RENDERER_VERSION = 8;

/** Fallback panel size when a screen has no geometry — a Seeed 7.5". */
export const DEFAULT_PANEL_WIDTH = 800;
export const DEFAULT_PANEL_HEIGHT = 480;

/** Only the screen fields the frame needs, so a partial row is enough to test. */
export interface FrameScreen {
  readonly panelWidth: number | null;
  readonly panelHeight: number | null;
  readonly panelColour: string | null;
  readonly rotation: number;
}

export interface ScreenFrame {
  readonly fb: Framebuffer;
  readonly etag: string;
  /** The civil date the frame is for, handy for logs and diagnostics. */
  readonly today: string;
}

/**
 * Which canvas a panel draws — the orientation a viewer sees after rotation.
 *
 * A panel mounted sideways (90/270) shows the *other* aspect than its native
 * one, and the household authors a portrait and a landscape canvas exactly like
 * a browser wall — so the endpoint reads the widgets for this orientation.
 */
export function epaperOrientation(screen: FrameScreen): 'portrait' | 'landscape' {
  const panelWidth = screen.panelWidth ?? DEFAULT_PANEL_WIDTH;
  const panelHeight = screen.panelHeight ?? DEFAULT_PANEL_HEIGHT;
  const swap = screen.rotation === 90 || screen.rotation === 270;
  const visualWidth = swap ? panelHeight : panelWidth;
  const visualHeight = swap ? panelWidth : panelHeight;
  return visualWidth >= visualHeight ? 'landscape' : 'portrait';
}

/**
 * Render a screen's frame — the household's free-form canvas when it has one for
 * this orientation, otherwise the fixed agenda-and-month layout.
 *
 * `widgets` are the rows for the orientation this panel shows (the caller reads
 * them, keeping this function free of the database). They join the ETag preimage
 * so re-arranging the layout changes the frame — without that, an edit would not
 * reach the panel until its calendar happened to change.
 *
 * **Handing over widgets is what asks for a canvas**, and the caller is the only
 * one who can answer: since direction B a panel may draw its own canvas, or a
 * wall's, or the built-in layout, and only `panelCanvasOwner` knows which. This
 * used to AND with `screen.layoutMode === 'freeform'` as well, which read as a
 * second opinion and was one — a following panel has no `freeform` of its own,
 * and the admin preview already had to lie about the column to draw a canvas at
 * all. An empty list is still the built-in layout, which is what a reset panel
 * and a saved-but-empty canvas both rely on (rule nine).
 */
export function renderScreenFrame(
  manifest: Manifest,
  screen: FrameScreen,
  widgets: readonly PlacedEpaperWidget[] = [],
): ScreenFrame {
  const panelWidth = screen.panelWidth ?? DEFAULT_PANEL_WIDTH;
  const panelHeight = screen.panelHeight ?? DEFAULT_PANEL_HEIGHT;
  const rotation = screen.rotation ?? 0;
  const swap = rotation === 90 || rotation === 270;
  const visual = { width: swap ? panelHeight : panelWidth, height: swap ? panelWidth : panelHeight };
  const freeform = widgets.length > 0;

  // Draw in the orientation a viewer sees; the panel's native buffer is
  // whatever `panelWidth × panelHeight` says, reached by turning the raster.
  const model = buildEpaperModel(manifest);
  const drawn = freeform
    ? renderFreeformEpaper(model, manifest, widgets, visual)
    : renderEpaper(model, visual);
  const fb = rotation === 0 ? drawn : rotate(drawn, rotation);

  const preimage = [
    EPAPER_RENDERER_VERSION,
    manifestEtag(manifest),
    `${panelWidth}x${panelHeight}`,
    // The resolved type tier — read off the panel's *visual* short side, which
    // is what `panelMetrics` reads and so what the frame was actually drawn at.
    typeTierFor(Math.min(visual.width, visual.height)).tier,
    screen.panelColour ?? 'bw',
    rotation,
    model.today,
    freeform ? JSON.stringify(widgets) : 'auto',
  ].join('|');
  const etag = `"${createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 32)}"`;

  return { fb, etag, today: model.today };
}
