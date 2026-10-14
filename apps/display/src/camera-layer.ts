import {
  cameraHandleOf,
  createPartReader,
  LIVE_STALE_SEC,
  pictureIsStale,
  retryDelayMs,
  type CameraLoad,
} from './camera.js';

/**
 * The camera pictures, on a layer the fifteen-second rebuild never touches
 * (plan item M6.1, RFC 007 §7.2).
 *
 * Every renderer here begins `root.textContent = ''`, so anything inside the
 * drawn tree is destroyed and made again four times a minute. A picture there
 * would be fetched again on every draw and flash blank each time, and a stream
 * (M6.2) would reconnect four times a minute for months. So the pictures live
 * in their own element beside `#wall`, made once and never cleared, carrying
 * the same frame and the same rotation; and after every draw this
 * *reconciles* rather than rebuilds: a picture the draw gained is made, one it
 * kept is moved to where its box now is, one it lost is removed — and a
 * picture's address changes only on its own timer.
 *
 * **Where a picture goes is where the draw put its box**, read back from the
 * page rather than worked out a second time: the box is the renderer's, so
 * one set of arithmetic decides both and a gutter, a group or a letterbox
 * cannot make them disagree. A client rectangle is turned by the rotation, so
 * it is turned back (`placeWithin`); offsets would avoid that and are whole
 * pixels, which leaves a hairline of the box showing.
 *
 * **Shown only over a plain canvas.** A takeover replaces the canvas and a
 * control panel opens over it; the layer is hidden for both, so a warning is
 * never behind a doorbell. Things a household stacks *over* a camera box are
 * under its picture, because the layer is above the whole wall — RFC 007 §7.2's
 * stated limit, and the reason a camera wants a corner of its own.
 *
 * Adopting the old `<img>` into the new tree after each clear would be
 * cheaper, and is deliberately not done: some engines abort a picture's fetch
 * when it leaves the document, and the wall targets several (RFC 007 §7.2).
 */

/** How long the wall gathers its own candidates before it sends its offer. */
const GATHER_MS = 3_000;
/** How often a WebRTC session is polled for late candidates, which keeps it open. */
const POLL_MS = 2_000;
/** A session that has drawn no frame by now falls back to the MJPEG stream. */
const FIRST_FRAME_MS = 10_000;

function canDecodeFrames(): boolean {
  return typeof createImageBitmap === 'function' && typeof ReadableStream === 'function';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Resolves once the connection has gathered its candidates, or after `ms`, whichever is first. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** A candidate as the server hands it on, or nothing. */
function candidateOf(raw: unknown): RTCIceCandidateInit | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const line = record['candidate'];
  if (typeof line !== 'string' || !line.startsWith('candidate:')) return undefined;
  const mid = record['sdpMid'];
  const index = record['sdpMLineIndex'];
  return {
    candidate: line,
    ...(typeof mid === 'string' ? { sdpMid: mid } : {}),
    ...(typeof index === 'number' ? { sdpMLineIndex: index } : {}),
    // A candidate with neither is for the first media section.
    ...(typeof mid !== 'string' && typeof index !== 'number' ? { sdpMLineIndex: 0 } : {}),
  };
}

function candidatesOf(raw: unknown): RTCIceCandidateInit[] {
  return Array.isArray(raw) ? raw.map(candidateOf).filter((c): c is RTCIceCandidateInit => c !== undefined) : [];
}

/** The server's answer to an offer, or nothing. */
export function sessionAnswer(raw: unknown): { session: string; answer: string; candidates: RTCIceCandidateInit[] } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const session = record['session'];
  const answer = record['answer'];
  if (typeof session !== 'string' || typeof answer !== 'string' || !answer.startsWith('v=0')) return undefined;
  return { session, answer, candidates: candidatesOf(record['candidates']) };
}

/** A poll's answer, or nothing. */
export function sessionPoll(raw: unknown): { ended: boolean; candidates: RTCIceCandidateInit[] } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return { ended: record['ended'] === true, candidates: candidatesOf(record['candidates']) };
}

/** What a box the renderer drew says about the picture that goes over it. */
interface BoxFacts {
  readonly widgetId: string;
  readonly handle: string;
  readonly refreshSec: number;
  readonly contain: boolean;
  /** The live stream (M6.2) rather than a picture every few seconds. */
  readonly live: boolean;
  /** Live over WebRTC first, with the MJPEG stream as the fallback. */
  readonly webrtc: boolean;
}

interface Picture {
  readonly element: HTMLElement;
  /** A snapshot's picture, or a live picture on a browser that cannot decode frames itself. */
  readonly img: HTMLImageElement;
  /** A live picture, drawn frame by frame (plan item M6.2); absent for a snapshot. */
  canvas: HTMLCanvasElement | undefined;
  /** A live picture over WebRTC, until it falls back to the MJPEG stream. */
  video: HTMLVideoElement | undefined;
  /** Asked for WebRTC; stays true after a fallback, so the box is not made again. */
  readonly webrtc: boolean;
  /** Ends a live picture's request. */
  abort: (() => void) | undefined;
  dropped: boolean;
  readonly caption: HTMLElement;
  handle: string;
  /** A live stream is one address held open; a snapshot is a new address on a timer. */
  readonly live: boolean;
  refreshSec: number;
  counter: number;
  failures: number;
  load: CameraLoad | undefined;
  lastLoadedAt: number | undefined;
  timer: number | undefined;
}

export interface CameraLayer {
  /** After a draw: put a picture over every camera box the draw left on the page, and none anywhere else. */
  reconcile(root: HTMLElement): void;
  /** What each widget's picture last did, by widget id, for the next draw's words under it. */
  loads(): Readonly<Record<string, CameraLoad>>;
}

export interface CameraLayerOptions {
  /** A picture arrived where there was none, or stopped arriving: the words under it should change. */
  readonly onLoadChange: () => void;
  readonly now: () => number;
  /** Where pictures are asked for; a test may point it elsewhere. */
  readonly base?: string;
  /** Where a WebRTC session is polled and ended. */
  readonly sessionBase?: string;
}

function factsOf(box: HTMLElement): BoxFacts | undefined {
  const widgetId = box.getAttribute('data-camera-widget');
  const handle = cameraHandleOf({ camera: box.getAttribute('data-camera') });
  if (widgetId === null || handle === undefined) return undefined;
  const refresh = Number(box.getAttribute('data-camera-refresh'));
  return {
    widgetId,
    handle,
    refreshSec: Number.isInteger(refresh) && refresh >= 1 && refresh <= 60 ? refresh : 3,
    contain: box.hasAttribute('data-camera-contain'),
    live: box.hasAttribute('data-camera-live'),
    webrtc: box.hasAttribute('data-camera-live') && box.hasAttribute('data-camera-webrtc'),
  };
}

/**
 * A box's place in the frame, in the frame's own unturned coordinates, or
 * nothing if it has no size. Read from the two rectangles the browser drew and
 * turned back through the frame's quarter turns, because offsets are whole
 * pixels and a picture half a pixel off its box shows a hairline of the box.
 */
function placeWithin(box: HTMLElement, frame: HTMLElement): { x: number; y: number; w: number; h: number } | undefined {
  const b = box.getBoundingClientRect();
  if (b.width === 0 || b.height === 0) return undefined;
  const f = frame.getBoundingClientRect();
  const turn = Number(frame.ownerDocument.documentElement.getAttribute('data-rotation') ?? '0');
  const dx = b.left - f.left;
  const dy = b.top - f.top;
  // The frame's own width and height: a quarter turn swaps what is drawn.
  const sideways = turn === 90 || turn === 270;
  const fw = sideways ? f.height : f.width;
  const fh = sideways ? f.width : f.height;
  if (turn === 90) return { x: dy, y: fh - dx - b.width, w: b.height, h: b.width };
  if (turn === 180) return { x: fw - dx - b.width, y: fh - dy - b.height, w: b.width, h: b.height };
  if (turn === 270) return { x: fw - dy - b.height, y: dx, w: b.height, h: b.width };
  return { x: dx, y: dy, w: b.width, h: b.height };
}

export function createCameraLayer(frame: HTMLElement, options: CameraLayerOptions): CameraLayer {
  const base = options.base ?? '/d/camera/';
  const sessionBase = options.sessionBase ?? '/d/camera-session/';
  const doc = frame.ownerDocument;
  const layer = doc.createElement('div');
  layer.id = 'camera-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.hidden = true;
  frame.parentNode?.insertBefore(layer, frame.nextSibling);

  const pictures = new Map<string, Picture>();

  const settle = (picture: Picture, load: CameraLoad): void => {
    const changed = picture.load !== load;
    picture.load = load;
    picture.element.classList.toggle('is-live', load === 'live');
    if (changed) options.onLoadChange();
  };

  const schedule = (picture: Picture, delayMs: number): void => {
    if (picture.timer !== undefined) window.clearTimeout(picture.timer);
    picture.timer = window.setTimeout(() => {
      picture.timer = undefined;
      ask(picture);
    }, delayMs);
  };

  /*
   * A new address each time, by a counter on the query string — a first-party
   * URL with nothing personal in it — because a browser may decline to fetch a
   * `src` that reads the same as the one it has (RFC 007 §7.3). The server
   * answers `no-store`, so nothing comes out of a cache either.
   */
  function ask(picture: Picture): void {
    picture.counter += 1;
    if (picture.video !== undefined) {
      void connect(picture, picture.video);
      return;
    }
    if (picture.canvas !== undefined) {
      void watch(picture, picture.canvas);
      return;
    }
    const what = picture.live ? 'stream' : 'still';
    picture.img.src = `${base}${encodeURIComponent(picture.handle)}/${what}?n=${picture.counter}`;
  }

  /*
   * A live picture, read rather than handed to an <img> (plan item M6.2).
   *
   * An <img> on a multipart stream draws its frames and says nothing about
   * them: Chromium fires one `load` on the first frame and nothing at all when
   * the stream ends, so a stream that stopped would leave the last frame up
   * for ever looking live. Read here, each frame is decoded and drawn onto a
   * canvas, so the layer knows when a frame last arrived (and can say a
   * picture is old) and knows when the stream ends (and asks again, backing
   * off). The frames are the server's own, under its own boundary with a
   * length, so they are read by their headers (`createPartReader`).
   *
   * A frame that arrives while the last is still being decoded replaces the
   * one waiting rather than queueing behind it: a slow tablet shows fewer
   * frames, never older ones.
   */
  async function watch(picture: Picture, canvas: HTMLCanvasElement): Promise<void> {
    const controller = new AbortController();
    picture.abort = () => controller.abort();
    let drew = false;
    try {
      const response = await fetch(`${base}${encodeURIComponent(picture.handle)}/stream?n=${picture.counter}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) throw new Error('no stream');
      const reader = response.body.getReader();
      const parts = createPartReader();
      let waiting: Uint8Array | undefined;
      let drawing = false;
      const draw = async (): Promise<void> => {
        drawing = true;
        while (waiting !== undefined && !picture.dropped) {
          const frame = waiting;
          waiting = undefined;
          try {
            const bitmap = await createImageBitmap(new Blob([frame as BlobPart], { type: 'image/jpeg' }));
            if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
            if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            bitmap.close();
            drew = true;
            picture.failures = 0;
            picture.lastLoadedAt = options.now();
            settle(picture, 'live');
          } catch {
            // One frame that will not decode is one frame missed.
          }
        }
        drawing = false;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done || picture.dropped) break;
        for (const frame of parts.push(value)) waiting = frame;
        if (waiting !== undefined && !drawing) void draw();
      }
    } catch {
      // An ended or refused stream is answered below, the same way.
    }
    picture.abort = undefined;
    if (picture.dropped) return;
    if (!drew) {
      picture.failures += 1;
      settle(picture, 'failed');
    }
    schedule(picture, drew ? 1_000 : retryDelayMs(picture.failures));
  }

  /*
   * A live picture over WebRTC (Hard rule 12's WebRTC exception).
   *
   * The wall makes the offer and gathers its own candidates before it sends
   * it, so nothing but that offer goes to the server; the server signals the
   * session with Home Assistant and hands back the answer and the media
   * server's candidates, then any late ones while the wall polls, and that
   * poll is what keeps the session open. No STUN or TURN server is named,
   * because a wall contacts no third party (rule three): the media server is
   * on the household's own network, and a host candidate reaches it.
   *
   * **A picture that never arrives falls back, for good.** A camera that does
   * not offer WebRTC is refused at once; a media server this screen cannot
   * reach is a session that never draws a frame. Either way the box becomes
   * the MJPEG stream (M6.2), which goes through this server and so reaches
   * any wall that can reach the server. One that drew and then stopped is
   * asked again, as a stream is.
   */
  async function connect(picture: Picture, video: HTMLVideoElement): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: [] });
    let session: string | undefined;
    let stopped = false;
    let drew = false;
    const endSession = (): void => {
      if (session !== undefined) {
        void fetch(`${sessionBase}${encodeURIComponent(session)}/end`, { method: 'POST', cache: 'no-store' }).catch(() => undefined);
        session = undefined;
      }
    };
    picture.abort = () => {
      stopped = true;
      pc.close();
      endSession();
    };
    const frameSeen = (): void => {
      drew = true;
      picture.failures = 0;
      picture.lastLoadedAt = options.now();
      settle(picture, 'live');
    };
    const watchFrames = (): void => {
      const withFrames = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };
      if (typeof withFrames.requestVideoFrameCallback === 'function') {
        const next = (): void => {
          if (stopped || picture.dropped) return;
          frameSeen();
          withFrames.requestVideoFrameCallback?.(next);
        };
        withFrames.requestVideoFrameCallback(next);
      } else {
        video.addEventListener('timeupdate', frameSeen);
      }
    };
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (event) => {
        if (event.track.kind !== 'video') return;
        video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void video.play().catch(() => undefined);
      };
      watchFrames();
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, GATHER_MS);
      const offer = pc.localDescription?.sdp;
      if (offer === undefined) throw new Error('no offer');
      const response = await fetch(`${base}${encodeURIComponent(picture.handle)}/webrtc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('no session');
      const started = sessionAnswer(await response.json());
      if (started === undefined) throw new Error('no session');
      session = started.session;
      await pc.setRemoteDescription({ type: 'answer', sdp: started.answer });
      let seen = 0;
      const add = async (candidates: readonly RTCIceCandidateInit[]): Promise<void> => {
        for (const candidate of candidates) await pc.addIceCandidate(candidate).catch(() => undefined);
        seen += candidates.length;
      };
      await add(started.candidates);
      const begun = options.now();
      for (;;) {
        await pause(POLL_MS);
        if (stopped || picture.dropped) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') break;
        // A session that has drawn nothing by now never will on this screen.
        if (!drew && options.now() - begun > FIRST_FRAME_MS) break;
        const polled = await fetch(`${sessionBase}${encodeURIComponent(started.session)}?after=${seen}`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : undefined))
          .catch(() => undefined);
        const late = sessionPoll(polled);
        if (late === undefined || late.ended) break;
        await add(late.candidates);
      }
    } catch {
      // A refusal, a browser that cannot, or an ended session: answered below.
    }
    if (stopped || picture.dropped) return;
    picture.abort = undefined;
    pc.close();
    endSession();
    if (!drew) {
      fallBack(picture);
      return;
    }
    schedule(picture, 1_000);
  }

  /** The box becomes the MJPEG stream it would have been without WebRTC. */
  function fallBack(picture: Picture): void {
    const video = picture.video;
    if (video === undefined) return;
    video.srcObject = null;
    video.remove();
    picture.video = undefined;
    picture.element.classList.remove('is-webrtc');
    const canvas = canDecodeFrames() ? doc.createElement('canvas') : undefined;
    picture.canvas = canvas;
    picture.element.insertBefore(canvas ?? picture.img, picture.caption);
    ask(picture);
  }

  function make(facts: BoxFacts): Picture {
    const element = doc.createElement('div');
    element.className = 'camera-pic';
    const img = doc.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    // A live picture on a browser that can decode frames itself is a canvas;
    // one that cannot (an old WebKit) keeps the <img>, which draws the stream
    // with no script and simply cannot say when it stops.
    const video = facts.webrtc && typeof RTCPeerConnection === 'function' ? doc.createElement('video') : undefined;
    if (video !== undefined) {
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      element.classList.add('is-webrtc');
    }
    const canvas = video === undefined && facts.live && canDecodeFrames() ? doc.createElement('canvas') : undefined;
    const caption = doc.createElement('div');
    caption.className = 'camera-stale';
    caption.hidden = true;
    element.appendChild(video ?? canvas ?? img);
    element.appendChild(caption);
    layer.appendChild(element);
    const picture: Picture = {
      element,
      img,
      canvas,
      video,
      webrtc: facts.webrtc,
      abort: undefined,
      dropped: false,
      caption,
      handle: facts.handle,
      live: facts.live,
      refreshSec: facts.refreshSec,
      counter: 0,
      failures: 0,
      load: undefined,
      lastLoadedAt: undefined,
      timer: undefined,
    };
    img.addEventListener('load', () => {
      picture.failures = 0;
      picture.lastLoadedAt = options.now();
      picture.caption.hidden = true;
      settle(picture, 'live');
      // A live stream keeps drawing into the same picture: nothing to schedule.
      if (!picture.live) schedule(picture, picture.refreshSec * 1000);
    });
    img.addEventListener('error', () => {
      picture.failures += 1;
      settle(picture, 'failed');
      schedule(picture, retryDelayMs(picture.failures));
    });
    ask(picture);
    return picture;
  }

  function drop(widgetId: string, picture: Picture): void {
    picture.dropped = true;
    picture.abort?.();
    if (picture.timer !== undefined) window.clearTimeout(picture.timer);
    // An empty `src` ends any fetch under way rather than letting it land on nothing.
    picture.img.removeAttribute('src');
    if (picture.video !== undefined) picture.video.srcObject = null;
    picture.element.remove();
    pictures.delete(widgetId);
  }

  return {
    reconcile(root: HTMLElement): void {
      /*
       * A plain canvas, or a takeover that shows a camera (plan item M6.3).
       * Any other takeover, a banner, the pairing form or a control panel
       * hides the pictures: a tornado warning is never behind a doorbell.
       */
      const plain =
        (root.querySelector('.canvas') !== null && root.querySelector('.hc-scrim') === null) ||
        root.querySelector('.alert-camera') !== null;
      const seen = new Set<string>();
      for (const box of Array.from(root.querySelectorAll<HTMLElement>('.fw-camera[data-camera-wanted]'))) {
        const facts = factsOf(box);
        const place = facts === undefined ? undefined : placeWithin(box, frame);
        if (facts === undefined || place === undefined) continue;
        seen.add(facts.widgetId);
        let picture = pictures.get(facts.widgetId);
        // A widget set to another camera, or switched between a picture every
        // few seconds and the live stream, is a new picture, not the old one renamed.
        if (
          picture !== undefined &&
          (picture.handle !== facts.handle || picture.live !== facts.live || picture.webrtc !== facts.webrtc)
        ) {
          drop(facts.widgetId, picture);
          picture = undefined;
        }
        if (picture === undefined) {
          picture = make(facts);
          pictures.set(facts.widgetId, picture);
        } else if (picture.refreshSec !== facts.refreshSec) {
          picture.refreshSec = facts.refreshSec;
          if (picture.load === 'live' && !picture.live) schedule(picture, picture.refreshSec * 1000);
        }
        const style = picture.element.style;
        style.left = `${place.x}px`;
        style.top = `${place.y}px`;
        style.width = `${place.w}px`;
        style.height = `${place.h}px`;
        style.borderRadius = getComputedStyle(box).borderRadius;
        picture.element.classList.toggle('is-contain', facts.contain);
        // A live picture drawn here knows when its last frame came; one an
        // <img> draws on its own does not, and is never called old.
        picture.caption.hidden =
          picture.live && picture.canvas === undefined && picture.video === undefined
            ? true
            : !pictureIsStale(picture.lastLoadedAt, options.now(), picture.live ? LIVE_STALE_SEC : picture.refreshSec);
        if (!picture.caption.hidden) picture.caption.textContent = 'This picture is not new — the camera has not sent another.';
      }
      for (const [widgetId, picture] of Array.from(pictures)) {
        if (!seen.has(widgetId)) drop(widgetId, picture);
      }
      layer.hidden = !plain || pictures.size === 0;
    },
    loads(): Readonly<Record<string, CameraLoad>> {
      const out: Record<string, CameraLoad> = {};
      for (const [widgetId, picture] of pictures) if (picture.load !== undefined) out[widgetId] = picture.load;
      return out;
    },
  };
}
