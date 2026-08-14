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
 */
export const EPAPER_RENDERER_VERSION = 1;

/** Fallback panel size when a screen has no geometry — a Seeed 7.5". */
export const DEFAULT_PANEL_WIDTH = 800;
export const DEFAULT_PANEL_HEIGHT = 480;

/** Only the screen fields the frame needs, so a partial row is enough to test. */
export interface FrameScreen {
  readonly panelWidth: number | null;
  readonly panelHeight: number | null;
  readonly panelColour: string | null;
  readonly rotation: number;
  /** `freeform` draws the household's canvas; anything else is the fixed layout. */
  readonly layoutMode?: string | null;
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
  const freeform = screen.layoutMode === 'freeform' && widgets.length > 0;

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
