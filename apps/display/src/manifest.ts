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
}

export interface ManifestShift {
  readonly key: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  readonly isWorking: boolean;
  readonly source: string;
  readonly personId: string;
  readonly personName: string;
  readonly personColor: string;
  readonly personAvatarUrl?: string | null;
}

export interface ManifestDay {
  readonly date: CivilDate;
  readonly shifts: readonly ManifestShift[];
  readonly events: readonly ManifestEvent[];
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
  };
  readonly window: { readonly from: CivilDate; readonly to: CivilDate };
  /** How much to show. Chosen by the household, not by this bundle. */
  readonly display?: {
    readonly todayEvents: number;
    readonly nextDays: number;
    readonly horizonWeeks: number;
    readonly blocks?: readonly string[];
  };
  /** How this screen is hung. Per screen, because they differ. */
  readonly screen?: {
    readonly orientation?: string;
    readonly rotation?: number;
    /** Whether this screen may offer a way to acknowledge an interrupt. */
    readonly allowDismiss?: boolean;
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
export function createManifestClient(fetchImpl: FetchLike, url = '/d/manifest'): ManifestClient {
  let etag: string | undefined;

  return {
    async poll(): Promise<FetchOutcome> {
      let response;
      try {
        response = await fetchImpl(url, {
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
