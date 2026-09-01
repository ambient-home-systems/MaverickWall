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
 */
import { createHash } from 'node:crypto';

import { manifestEtag, type Manifest } from '../api/manifest.js';

import { Framebuffer, rotate } from './framebuffer.js';
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
 * 4: the layout is proportional to the panel (`epaper/metrics.ts`). Every
 * absolute pixel the frame was drawn with — the 16px margin, the 54px header,
 * the 34px agenda row, the 26px week head, the 34px pill threshold, the six
 * agenda rows and the four cell names — was tuned by looking at one 800×480
 * Seeed panel and applied to a range running 640×384 to 1872×1404. So *every*
 * paired panel's pixels move here, including the 800×480 ones, whose month grid
 * now fills the column it used to stop halfway down. This is the bump that
 * matters most so far: without it a 13.3" panel would keep serving the frame
 * with 714px of white at the bottom until its calendar happened to change, and
 * "the update did nothing" is indistinguishable from "the update was wrong".
 */
export const EPAPER_RENDERER_VERSION = 4;

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
    screen.panelColour ?? 'bw',
    rotation,
    model.today,
    freeform ? JSON.stringify(widgets) : 'auto',
  ].join('|');
  const etag = `"${createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 32)}"`;

  return { fb, etag, today: model.today };
}
