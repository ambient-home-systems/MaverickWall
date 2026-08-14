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
}

export interface ScreenFrame {
  readonly fb: Framebuffer;
  readonly etag: string;
  /** The civil date the frame is for, handy for logs and diagnostics. */
  readonly today: string;
}

export function renderScreenFrame(manifest: Manifest, screen: FrameScreen): ScreenFrame {
  const panelWidth = screen.panelWidth ?? DEFAULT_PANEL_WIDTH;
  const panelHeight = screen.panelHeight ?? DEFAULT_PANEL_HEIGHT;
  const rotation = screen.rotation ?? 0;
  const swap = rotation === 90 || rotation === 270;

  // Draw in the orientation a viewer sees; the panel's native buffer is
  // whatever `panelWidth × panelHeight` says, reached by turning the raster.
  const model = buildEpaperModel(manifest);
  const visual = renderEpaper(model, {
    width: swap ? panelHeight : panelWidth,
    height: swap ? panelWidth : panelHeight,
  });
  const fb = rotation === 0 ? visual : rotate(visual, rotation);

  const preimage = [
    EPAPER_RENDERER_VERSION,
    manifestEtag(manifest),
    `${panelWidth}x${panelHeight}`,
    screen.panelColour ?? 'bw',
    rotation,
    model.today,
  ].join('|');
  const etag = `"${createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 32)}"`;

  return { fb, etag, today: model.today };
}
