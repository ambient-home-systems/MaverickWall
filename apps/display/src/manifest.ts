/**
 * The manifest, as the display sees it.
 *
 * A structural copy of the server's contract rather than a shared package.
 * The display is the one consumer, it talks to exactly one server, and the
 * version is negotiated by `manifestVersion` rather than by a build. Importing
 * the server's types would drag its dependencies into a bundle that is
 * forbidden from having any.
 */

export type CivilDate = string;

/**
 * A canvas background (RFC 005 Phase 3): a solid colour or a two-stop gradient.
 * The server validated and clamped it; the wall draws it behind the widgets.
 */
export type CanvasBackground =
  | { readonly type: 'solid'; readonly color: string }
  | { readonly type: 'gradient'; readonly from: string; readonly to: string; readonly angle: number }
  | { readonly type: 'image'; readonly image: string };

export interface ManifestEvent {
  readonly id: string;
  readonly uid: string;
  readonly title: string;
  readonly location?: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: boolean;
  readonly sourceId: string;
  readonly color: string;
  readonly status: string;
  readonly continues: boolean;
  /** Whose event this is, when its calendar has an owner. Looked up in `people`. */
  readonly personId?: string;
}

export interface ManifestShift {
  readonly key: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  /** An explicit per-type colour; the display derives its tint. Absent = token. */
  readonly color?: string;
  /** Optional `HH:MM` window drawn on the wall. Absent = an untimed shift. */
  readonly startTime?: string;
  readonly endTime?: string;
  readonly isWorking: boolean;
  readonly source: string;
  /**
   * How far through a run of this shift today is, from the server. Present
   * only on today's entries, and absent from a server older than the field —
   * where the display falls back to counting the manifest's own days, which is
   * the thing that could only ever reach "Day 2".
   */
  readonly run?: { readonly position: number; readonly total: number };
  readonly personId: string;
  readonly personName: string;
  readonly personColor: string;
  readonly personAvatarUrl?: string | null;
}

export interface ManifestDay {
  readonly date: CivilDate;
  readonly shifts: readonly ManifestShift[];
  readonly events: readonly ManifestEvent[];
  /**
   * Which week of the year this day is in. Absent from a server older than the
   * field, and from a manifest cached in IndexedDB before it existed — a wall
   * runs for months without reloading, so both are ordinary rather than
   * theoretical, and the label is simply not drawn.
   */
  readonly weekNumber?: number;
}

export interface ManifestPerson {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly hasShiftRotation: boolean;
  readonly avatarUrl?: string | null;
}

export interface ManifestNotice {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface ManifestSourceHealth {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
}

export interface ManifestWidget {
  readonly id: string;
  /** A first-party module: clock, calendar, weather, homeassistant, shift, … */
  readonly type: string;
  /** Top-left and size, each a fraction 0..1 of the canvas. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config?: unknown;
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly appVersion: string;
  readonly generatedAt: number;
  readonly timezone: string;
  readonly theme: {
    readonly active: string;
    readonly daytime?: string;
    readonly daytimeStartsAt?: string;
    readonly daytimeEndsAt?: string;
    /**
     * For a custom theme, the resolved token set to apply and the `data-theme`
     * shape to set. Built-in themes carry no tokens — this bundle owns them and
     * resolves them from the key. Absent on an older server, so both are
     * optional and the key path is the fallback.
     */
    readonly activeShape?: string;
    readonly activeTokens?: Readonly<Record<string, string>>;
    readonly daytimeShape?: string;
    readonly daytimeTokens?: Readonly<Record<string, string>>;
  };
  readonly window: { readonly from: CivilDate; readonly to: CivilDate };
  /** How much to show. Chosen by the household, not by this bundle. */
  readonly display?: {
    readonly todayEvents: number;
    readonly nextDays: number;
    readonly horizonWeeks: number;
    readonly blocks?: readonly string[];
    /** 24-hour clock (the default) or 12-hour when the household turns it off. */
    readonly clock24?: boolean;
    /** Which day the month grid starts on. Absent (an older server) is Sunday. */
    readonly weekStart?: 'sunday' | 'monday';
  };
  /**
   * The free-form layout, when the household arranged one.
   *
   * A display authors two canvases — `portrait` and `landscape` — and the wall
   * draws the one matching how it is hung; a canvas that is empty letterboxes the
   * other (RFC 005). Optional and defaulted throughout: an older bundle that does
   * not read this simply draws the responsive blocks, and a manifest without it
   * (or with `mode` anything but `freeform`) does the same. The server has already
   * clamped every coordinate and dropped any type this bundle has no widget for,
   * so the renderer trusts what it is handed.
   *
   * `aspect`/`widgets` at the top level are the *legacy* single-canvas shape,
   * still read from a manifest a pre-split bundle cached, so a free-form wall does
   * not flash to the responsive layout for one poll after an upgrade.
   */
  readonly layout?: {
    readonly mode?: string;
    readonly portrait?: { readonly aspect?: number; readonly widgets?: readonly ManifestWidget[]; readonly background?: CanvasBackground };
    readonly landscape?: { readonly aspect?: number; readonly widgets?: readonly ManifestWidget[]; readonly background?: CanvasBackground };
    /** Legacy single-canvas shape (pre-RFC-005). Width ÷ height, and its widgets. */
    readonly aspect?: number;
    readonly widgets?: readonly ManifestWidget[];
  };
  /** How this screen is hung. Per screen, because they differ. */
  readonly screen?: {
    readonly orientation?: string;
    readonly rotation?: number;
    /** Whether this screen may offer a way to acknowledge an interrupt. */
    readonly allowDismiss?: boolean;
    readonly allowChores?: boolean;
  };
  readonly days: readonly ManifestDay[];
  readonly people: readonly ManifestPerson[];
  readonly sources: readonly ManifestSourceHealth[];
  readonly notices: readonly ManifestNotice[];
  /** Panel slices keyed by block. Data only — never anything to execute. */
  readonly panels?: Readonly<Record<string, unknown>>;
  /**
   * Anything to say over the top of the calendar, highest priority first.
   *
   * Already evaluated by the server. The display decides only how loudly to
   * draw one — the rules, the thresholds and the entities that produced it
   * never leave the server.
   */
  readonly interrupts?: readonly {
    readonly id: string;
    readonly name: string;
    readonly message: string;
    readonly action: string;
    readonly priority: number;
  }[];
}

/**
 * Enough of a check to refuse a document that would render as nonsense.
 *
 * Not a schema validator. The display's failure mode has to be "keep showing
 * what I had", so this asks only whether the reply is recognisably a manifest
 * of a version this bundle understands — a proxy login page, an error object,
 * or a future major version all fail here and the caller keeps the last good
 * one rather than clearing the screen.
 */
export function isRenderableManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Manifest>;
  return (
    candidate.manifestVersion === 1 &&
    typeof candidate.generatedAt === 'number' &&
    typeof candidate.timezone === 'string' &&
    Array.isArray(candidate.days) &&
    Array.isArray(candidate.notices)
  );
}

export type FetchOutcome =
  /** New document. */
  | { readonly status: 'fresh'; readonly manifest: Manifest; readonly serverTime: number }
  /** Server says nothing changed. Whatever is on screen is still correct. */
  | { readonly status: 'unchanged'; readonly serverTime: number }
  /** This screen is not paired, or its token was revoked. */
  | { readonly status: 'unpaired' }
  /** Anything else: offline, a 500, a body that is not a manifest. */
  | { readonly status: 'failed'; readonly reason: string };

export interface ManifestClient {
  poll(): Promise<FetchOutcome>;
}

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Polls `/d/manifest`, holding the ETag so an unchanged wall costs one 304.
 *
 * The server sends its time in a header as well as the body precisely so a 304
 * still carries it — a display that is correctly getting 304s all day would
 * otherwise never correct its clock drift.
 */
export function createManifestClient(
  fetchImpl: FetchLike,
  url = '/d/manifest',
  // The wall's own viewport, reported so the editor can offer "match this
  // screen's size" (RFC 005). Optional and dimension-only — the DOM access stays
  // in the caller, so this module remains testable without a window.
  viewport?: () => { w: number; h: number },
): ManifestClient {
  let etag: string | undefined;

  return {
    async poll(): Promise<FetchOutcome> {
      // Append the viewport as query params. A stable size means a stable URL,
      // so the ETag path is unaffected; a resize just costs one full fetch.
      let requestUrl = url;
      if (viewport !== undefined) {
        const { w, h } = viewport();
        if (w > 0 && h > 0) {
          requestUrl += `${url.includes('?') ? '&' : '?'}w=${Math.round(w)}&h=${Math.round(h)}`;
        }
      }

      let response;
      try {
        response = await fetchImpl(requestUrl, {
          headers: etag === undefined ? {} : { 'if-none-match': etag },
        });
      } catch (error) {
        return { status: 'failed', reason: error instanceof Error ? error.message : 'offline' };
      }

      const headerTime = Number(response.headers.get('x-server-time'));
      const serverTime = Number.isFinite(headerTime) && headerTime > 0 ? headerTime : 0;

      if (response.status === 304) return { status: 'unchanged', serverTime };
      if (response.status === 401) return { status: 'unpaired' };
      if (response.status < 200 || response.status >= 300) {
        return { status: 'failed', reason: `server answered ${response.status}` };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'failed', reason: 'reply was not readable' };
      }
      if (!isRenderableManifest(body)) return { status: 'failed', reason: 'reply was not a manifest' };

      // Only stored once the body has been accepted. Keeping an ETag for a
      // document that was rejected would make the server answer 304 forever
      // and the screen would never recover.
      const fresh = response.headers.get('etag');
      etag = fresh === null ? undefined : fresh;

      return { status: 'fresh', manifest: body, serverTime: serverTime || body.generatedAt };
    },
  };
}
