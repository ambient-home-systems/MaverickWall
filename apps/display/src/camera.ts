/**
 * A camera widget, as far as it can be decided without a page (plan item M6.1,
 * RFC 007 Tier A): which camera a box names, whether the manifest says it is
 * there, how often its picture is fetched again, and what the box says while
 * there is no picture to show.
 *
 * Pure for the reason `widget-options.ts` is: there is no DOM in the display's
 * tests, so a rule decided inside a `createElement` call is a rule nothing can
 * check. `camera-layer.ts` is the half that touches the page.
 */

/** A camera's handle: what the server minted when it was added, and the only name a wall has for it. */
export const CAMERA_HANDLE = /^[A-Za-z0-9_-]{43}$/;

/** How often a picture is fetched again when the widget does not say. */
export const DEFAULT_REFRESH_SEC = 3;

/** One camera, as the manifest's `cameras` panel names it. Never an entity id. */
export interface CameraModel {
  readonly handle: string;
  readonly available: boolean;
}

/** What the picture this browser last asked for did: arrived, or did not. */
export type CameraLoad = 'live' | 'failed';

/** The `cameras` panel, read defensively: a malformed entry is no camera rather than a thrown draw. */
export function camerasFrom(panel: unknown): readonly CameraModel[] {
  if (typeof panel !== 'object' || panel === null) return [];
  const list = (panel as Record<string, unknown>)['cameras'];
  if (!Array.isArray(list)) return [];
  const out: CameraModel[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const handle = (entry as Record<string, unknown>)['handle'];
    if (typeof handle !== 'string' || !CAMERA_HANDLE.test(handle)) continue;
    out.push({ handle, available: (entry as Record<string, unknown>)['available'] !== false });
  }
  return out;
}

/** The camera a widget names, by handle, or nothing. */
export function cameraHandleOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const handle = (config as Record<string, unknown>)['camera'];
  return typeof handle === 'string' && CAMERA_HANDLE.test(handle) ? handle : undefined;
}

/** Seconds between pictures: the widget's own, inside 1–60, else the default. */
export function refreshSeconds(config: unknown): number {
  const raw = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['cameraRefreshSec'] : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 60 ? raw : DEFAULT_REFRESH_SEC;
}

/** Whether the box shows the camera's live stream rather than a picture every few seconds (plan item M6.2). */
export function cameraIsLive(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const mode = (config as Record<string, unknown>)['cameraMode'];
  return mode === 'stream' || mode === 'webrtc';
}

/**
 * Whether a live picture is asked for over WebRTC first (Hard rule 12's
 * WebRTC exception): straight from Home Assistant's media server, with the
 * MJPEG stream as the fallback when the camera or the browser cannot.
 */
export function cameraIsWebrtc(config: unknown): boolean {
  return typeof config === 'object' && config !== null && (config as Record<string, unknown>)['cameraMode'] === 'webrtc';
}

/** Whether the picture sits whole in its box rather than filling it (cropped). */
export function cameraContains(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const fit = (config as Record<string, unknown>)['fit'];
  return fit === 'contain' || fit === 'blur';
}

/**
 * Whether the page should ask for this camera's picture at all. A camera the
 * manifest does not list (removed since), or lists as not there, is never
 * asked for: the box says so, and nothing hammers a house for a picture that
 * cannot come (RFC 007 §7.3).
 */
export function cameraWanted(cameras: readonly CameraModel[], handle: string | undefined): boolean {
  if (handle === undefined) return false;
  return cameras.some((camera) => camera.handle === handle && camera.available);
}

/**
 * The words the box says underneath the picture, which are what shows while
 * there is no picture — never a black rectangle, which looks deliberate, and
 * never a hole (RFC 007 §7.2). Empty once a picture is up, since it is under it.
 */
export function cameraNote(
  cameras: readonly CameraModel[],
  handle: string | undefined,
  load: CameraLoad | undefined,
  /** False in the editor's preview, which draws the box and never fetches the picture. */
  onWall = true,
): string {
  if (handle === undefined) return 'Choose a camera in this widget’s options.';
  if (!cameraWanted(cameras, handle)) return 'This camera is not answering at the moment.';
  if (!onWall) return 'The camera’s picture is shown here on the wall.';
  if (load === 'failed') return 'No picture from this camera just now.';
  if (load === 'live') return '';
  return 'Waiting for the first picture.';
}

/** Retry a failed picture after this long, doubling from five seconds to a minute (RFC 007 §7.3). */
export function retryDelayMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Whether the picture showing is old enough to say so: older than three
 * refreshes, which is three chances missed (RFC 007 §7.3).
 */
export function pictureIsStale(lastLoadedAt: number | undefined, now: number, refreshSec: number): boolean {
  return lastLoadedAt !== undefined && now - lastLoadedAt > 3 * refreshSec * 1000;
}

/**
 * Seconds without a new frame before a live picture is called old: three
 * times the hub's quiet reopen, less a margin (plan item M6.2).
 */
export const LIVE_STALE_SEC = 10;

/** The boundary the server writes every frame under (`modules/cameras/multipart.ts`). */
export const CAMERA_BOUNDARY = 'mw-camera-frame';

/**
 * Whole frames out of the server's own live stream (plan item M6.2).
 *
 * The server re-frames every picture under its own boundary with a
 * `Content-Length`, so unlike a camera's stream this one can be read by its
 * headers: find a part's header, read its length, take that many bytes. A part
 * whose header is not ours, or whose length is not a number, is skipped to the
 * next boundary rather than trusted. Bytes in, frames out, no page.
 */
export interface PartReader {
  push(chunk: Uint8Array): Uint8Array[];
}

export function createPartReader(maxFrameBytes = 4 * 1024 * 1024): PartReader {
  // One growing buffer rather than a copy per chunk: a large frame in small
  // pieces would otherwise be copied once per piece.
  let buffer = new Uint8Array(64 * 1024);
  let length = 0;
  /** Where the next unread part starts. */
  let at = 0;
  const marker = `--${CAMERA_BOUNDARY}`;
  const ascii = (from: number, to: number): string => {
    let text = '';
    for (let i = from; i < to; i++) text += String.fromCharCode(buffer[i] as number);
    return text;
  };
  const find = (needle: string, from: number): number => {
    outer: for (let i = from; i + needle.length <= length; i++) {
      for (let j = 0; j < needle.length; j++) if (buffer[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  };
  const compact = (): void => {
    if (at === 0) return;
    buffer.copyWithin(0, at, length);
    length -= at;
    at = 0;
  };
  return {
    push(chunk: Uint8Array): Uint8Array[] {
      compact();
      if (length + chunk.length > buffer.length) {
        let size = buffer.length;
        while (size < length + chunk.length) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(chunk, length);
      length += chunk.length;
      const frames: Uint8Array[] = [];
      for (;;) {
        const part = find(marker, at);
        if (part < 0) {
          // Keep a tail that may be the start of the next boundary.
          at = Math.max(at, length - marker.length);
          return frames;
        }
        const headEnd = find('\r\n\r\n', part);
        if (headEnd < 0) {
          at = part;
          return frames;
        }
        const header = /content-length:\s*(\d+)/i.exec(ascii(part, headEnd));
        const size = header === null ? NaN : Number(header[1]);
        if (!Number.isInteger(size) || size <= 0 || size > maxFrameBytes) {
          at = part + marker.length;
          continue;
        }
        const start = headEnd + 4;
        if (length < start + size) {
          at = part;
          return frames;
        }
        frames.push(buffer.slice(start, start + size));
        at = start + size;
      }
    },
  };
}
