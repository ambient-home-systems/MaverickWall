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

/**
 * The code the server stamps on the stand-in it sends when it could not read
 * its own database. Named here because the display has to recognise it.
 */
const STAND_IN_NOTICE = 'schema-degraded';

/**
 * Is this the household's calendar, or the stand-in for one?
 *
 * The server answers `/d/manifest` with an *empty but valid* manifest when it
 * could not read its own database, carrying a notice that says so — the whole
 * point of which is that the wall draws the reason instead of a black screen.
 * It is a renderable manifest by construction, so nothing else can tell it
 * apart, and that is how it came to be written over the wall's own memory: a
 * screen drew it, then saved it, and a reload had nothing left to fall back
 * to. Drawing it is right. Remembering it is not — it is the one document the
 * server sends that is explicitly not the household's data.
 *
 * Kept here rather than in the poll loop because there is no DOM in this
 * package's tests, so a rule that lives in `main.ts` is a rule nothing can
 * check.
 */
export function isStandInManifest(manifest: Manifest): boolean {
  /*
   * Tolerant of a document with no `notices` at all, because one caller passes
   * the copy read out of IndexedDB, which `store.load()` deliberately does not
   * shape-check — a manifest written by an older bundle is a real possibility
   * on a wall that has been hanging for months. Reading `.some` off `undefined`
   * there would throw *inside the poll*, which is a far worse failure than the
   * one this whole file is about: `draw` is wrapped in `safely` and a poll is
   * not, so the wall would stop updating for good.
   */
  const notices = manifest.notices as readonly ManifestNotice[] | undefined;
  if (!Array.isArray(notices)) return false;
  return notices.some((notice) => notice?.code === STAND_IN_NOTICE);
}

/**
 * A stand-in is a fallback, not a replacement.
 *
 * The server sends it when it cannot read its own database, and the wall's
 * answer should depend on what it already has. With nothing — a screen booted
 * during the outage — drawing it is the entire point of RFC 009 1.9: an empty
 * calendar with the reason on it beats a black screen. With a real calendar
 * already on the glass, replacing it with an empty one throws away the more
 * useful half of the wall; the offline banner already says the wall is not
 * being kept up to date, and yesterday's calendar is still mostly true. Not
 * saving the stand-in was only half of that — nothing could reach the saved
 * copy while the stand-in kept arriving and overwriting what was on screen, so
 * a reload flashed the real calendar and dropped straight back to the empty
 * one.
 *
 * `heldIsReal` is tracked by the caller rather than re-derived from the held
 * document, because `keepHeld` below folds the stand-in's notices *into* what
 * is held — so asking the document would answer "this is a stand-in" from the
 * second poll on and let the empty one through after all.
 */
export function shouldKeepHeld(heldIsReal: boolean, incoming: Manifest): boolean {
  return heldIsReal && isStandInManifest(incoming);
}

/**
 * The household's data, with the server's live commentary over the top.
 *
 * Keeping the calendar must not mean discarding what the stand-in came to say,
 * and there is exactly one thing on it worth having: `notices`. It is the only
 * text on the wall that names the fault and points at System, and without it
 * the household reads their own calendar under a banner about the server being
 * unreachable, which is false — it is up and answering.
 *
 * Everything else stays as it was, `interrupts` emphatically included. Taking
 * those looked right — an acknowledgement is recorded server-side and it is the
 * re-poll that clears a takeover, so a frozen copy leaves a warning the OK
 * button cannot dismiss — but it has the sign wrong. The stand-in is built with
 * no interrupts at all, because the server that could evaluate a rule is the
 * one that cannot read its database, so merging them does not *clear* an
 * acknowledged warning, it silently drops a live unacknowledged one. A tornado
 * takeover must not vanish because a migration failed. The honest outcome is
 * the one the `failed` branch already states in its own comment: the interrupt
 * stays up, because nothing has been acknowledged as far as the household is
 * concerned.
 */
export function keepHeld(held: Manifest, incoming: Manifest): Manifest {
  return { ...held, notices: incoming.notices };
}

/**
 * Whether the copy read out of IndexedDB is still worth putting up.
 *
 * The load is asynchronous and the first poll is not waited for, so on a slow
 * tablet the server can answer first — and if what it answered with was the
 * stand-in, the boot guard's "only when there is nothing yet" let an empty
 * document beat the household's real cached calendar to the screen. Worse, it
 * then stuck: the held manifest was itself a stand-in, so `shouldKeepHeld` said
 * no for ever after. A stand-in is not something the stored copy has to defer
 * to; a real calendar the server has just sent is.
 *
 * Told rather than asked, exactly as `shouldKeepHeld` is, and for the same
 * reason: `keepHeld` folds the stand-in's notices into the held document, so a
 * document that reads as a stand-in is not the same question as a wall that is
 * showing one. One of this pair asking and the other being told is the drift
 * worth avoiding.
 */
export function shouldAdoptStored(heldIsReal: boolean): boolean {
  return !heldIsReal;
}

/**
 * The one sentence worth taking off a refusal.
 *
 * The server's own error bodies carry a `message` written for somebody standing
 * in a kitchen — "This wall could not be built just now", and what the screen
 * will do about it — and until now every non-2xx body was thrown away unread,
 * so a wall that had never cached a manifest could only say it was not reaching
 * a server that was up and answering.
 *
 * Everything here is defensive rather than trusting: a reply that is not JSON,
 * or has no `message`, or is something other than a string, yields nothing and
 * the caller falls back to its own wording. It is capped because this is drawn,
 * and control characters go because a wall that has one line to say something
 * cannot afford it to be unreadable. Nothing is ever inserted as markup —
 * `render.ts` sets `textContent` — so this is about legibility, not injection.
 */
async function sentenceFrom(response: { json(): Promise<unknown> }): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  const clean = message.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, 200);
}

export type FetchOutcome =
  /** New document. */
  | { readonly status: 'fresh'; readonly manifest: Manifest; readonly serverTime: number }
  /** Server says nothing changed. Whatever is on screen is still correct. */
  | { readonly status: 'unchanged'; readonly serverTime: number }
  /** This screen is not paired, or its token was revoked. */
  | { readonly status: 'unpaired' }
  /** Anything else: offline, a 500, a body that is not a manifest. */
  | {
      readonly status: 'failed';
      readonly reason: string;
      /**
       * Whether the server answered at all.
       *
       * A refusal and an unreachable server are not the same event, and the
       * display was treating them as one: it drew "Not reaching the server"
       * over a wall whose server had just replied, stopped advancing
       * `lastContactAt`, and so tripped a watchdog limit `watchdog.ts` says is
       * for the case where *we* are broken.
       *
       * Not merely "an HTTP reply arrived" — a captive portal's cheerful 200
       * and a proxy's own error page are both replies, and neither is this
       * wall's server. It is the `x-server-time` header, which `/d/manifest`
       * sets on every answer it gives including a refusal, and which nothing
       * in between has any reason to invent.
       */
      readonly answered: boolean;
      /**
       * What the server said, when it said anything.
       *
       * A refusal is not the same event as a wall that cannot reach anything,
       * and the display has no way to tell them apart from a status code: both
       * arrive as `failed`. So a body carrying a household-readable `message`
       * is kept, and a screen with nothing else to draw shows that sentence
       * instead of guessing at the network. `reason` stays what it was —
       * diagnostic, never drawn.
       */
      readonly serverSaid?: string;
    };

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
        return {
          status: 'failed',
          answered: false,
          reason: error instanceof Error ? error.message : 'offline',
        };
      }

      const stamp = response.headers.get('x-server-time');
      const headerTime = Number(stamp);
      const serverTime = Number.isFinite(headerTime) && headerTime > 0 ? headerTime : 0;
      // Presence, not value: the header is what identifies a reply as this
      // wall's own server rather than whatever else answered on the way.
      const answered = stamp !== null;

      if (response.status === 304) return { status: 'unchanged', serverTime };
      /*
       * And only *our* 401 unpairs a screen. It is the most destructive answer
       * the display acts on — the manifest is dropped, the code-entry form
       * goes up and `pairingShown` latches — so a hotel captive portal or a
       * proxy asking for its own credentials must not be able to take a
       * household's calendar off the wall and ask them to pair it again.
       * Anything else 401 is simply not reaching this wall's server.
       */
      if (response.status === 401) {
        return answered
          ? { status: 'unpaired' }
          : { status: 'failed', answered: false, reason: 'a 401 from something else' };
      }
      if (response.status < 200 || response.status >= 300) {
        // Only ours has anything to say. A proxy's JSON `message` drawn on a
        // wall as "the server said" would be a stranger's sentence with this
        // product's authority behind it.
        const said = answered ? await sentenceFrom(response) : undefined;
        const failed = {
          status: 'failed',
          answered,
          reason: `server answered ${response.status}`,
        } as const;
        return said === undefined ? failed : { ...failed, serverSaid: said };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'failed', answered, reason: 'reply was not readable' };
      }
      if (!isRenderableManifest(body)) {
        return { status: 'failed', answered, reason: 'reply was not a manifest' };
      }

      // Only stored once the body has been accepted. Keeping an ETag for a
      // document that was rejected would make the server answer 304 forever
      // and the screen would never recover.
      const fresh = response.headers.get('etag');
      etag = fresh === null ? undefined : fresh;

      return { status: 'fresh', manifest: body, serverTime: serverTime || body.generatedAt };
    },
  };
}
