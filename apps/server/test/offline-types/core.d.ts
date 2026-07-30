/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 * Stands in for the @maverick-wall/core workspace package, which is not built
 * in this environment. The real package's own types are the authority.
 */
declare module '@maverick-wall/core' {
  export interface ParsedIp { readonly version: 4 | 6; readonly bytes: readonly number[] }
  export function parseIp(text: string): ParsedIp | undefined;
  export function classifyIp(ip: ParsedIp): string;
  export function isLocalNetwork(ip: ParsedIp): boolean;
  export function formatIp(ip: ParsedIp): string;

  export interface UrlPolicy {
    readonly allowHttp?: boolean;
    readonly allowPrivateNetwork?: boolean;
    readonly allowLoopback?: boolean;
    readonly maxLength?: number;
  }
  export interface ValidatedUrl {
    readonly href: string;
    readonly protocol: 'http:' | 'https:';
    readonly hostname: string;
    readonly port: string;
    readonly isIpLiteral: boolean;
    readonly ip?: ParsedIp;
  }
  export interface UrlRejection { readonly code: string; readonly message: string }
  export type ValidateUrlResult =
    | { readonly ok: true; readonly value: ValidatedUrl }
    | { readonly ok: false; readonly error: UrlRejection };
  export function validateOutboundUrl(raw: string, policy?: UrlPolicy): ValidateUrlResult;
  export function validateRedirect(
    location: string, from: ValidatedUrl, policy?: UrlPolicy,
  ): ValidateUrlResult;
  export function isCrossOrigin(from: ValidatedUrl, to: ValidatedUrl): boolean;

  export type FetchRejectionCode =
    | 'url-rejected' | 'address-rejected' | 'dns-failed'
    | 'redirect-rejected' | 'too-many-redirects';
  export type FetchFailureCode =
    | 'timeout' | 'too-large' | 'unacceptable-content-type'
    | 'http-error' | 'network-error';

  export interface FetchRequest {
    readonly url: string;
    readonly policy: UrlPolicy;
    readonly maxBytes: number;
    readonly timeoutMs?: number;
    readonly acceptContentTypes?: readonly string[];
    readonly conditional?: { readonly etag?: string; readonly lastModified?: string };
    readonly headers?: Readonly<Record<string, string>>;
    readonly userAgent?: string;
  }
  export type FetchOutcome =
    | { readonly status: 'ok'; readonly body: string; readonly contentType: string;
        readonly etag?: string; readonly lastModified?: string;
        readonly finalUrl: string; readonly byteSize: number }
    | { readonly status: 'not-modified'; readonly etag?: string; readonly lastModified?: string }
    | { readonly status: 'rejected'; readonly code: FetchRejectionCode; readonly message: string }
    | { readonly status: 'failed'; readonly code: FetchFailureCode; readonly message: string;
        readonly httpStatus?: number; readonly retryAfterSeconds?: number };
  export interface Fetcher { fetch(request: FetchRequest): Promise<FetchOutcome> }
  export const FETCH_LIMITS: { ics: number; json: number; image: number };
}

declare module '@maverick-wall/calendar' {
  export interface NormalizedEvent {
    readonly uid: string;
    readonly recurrenceId?: string;
    readonly title: string;
    readonly startUtc: Date;
    readonly endUtc: Date;
    readonly allDay: boolean;
    readonly sourceTzid: string;
    readonly location?: string;
    readonly status: 'CONFIRMED' | 'TENTATIVE';
    readonly isRecurringInstance: boolean;
    readonly description?: string;
  }
  export interface CalendarError {
    readonly code: string;
    readonly message: string;
    readonly detail?: string;
  }
  export function expandCalendar(input: {
    readonly icsText: string;
    readonly targetTimezone: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly maxEvents?: number;
    readonly includeDescription?: boolean;
  }):
    | {
        readonly ok: true;
        readonly value: NormalizedEvent[];
        readonly meta: { readonly warnings: readonly { code: string; message: string }[] };
      }
    | { readonly ok: false; readonly error: CalendarError };
  export function localDateOf(instantMs: number, timeZone: string): string;
}

declare module '@maverick-wall/core' {
  export interface JobRecord {
    readonly key: string;
    readonly kind: string;
    readonly nextRunAt: number;
    readonly consecutiveFailures: number;
    readonly runningSince?: number | undefined;
  }
  export interface JobFinish {
    readonly lastRunAt: number;
    readonly lastDurationMs: number;
    readonly nextRunAt: number;
    readonly consecutiveFailures: number;
    readonly lastError: string | null;
  }
  export interface JobStore {
    due(now: number, staleBefore: number): readonly JobRecord[];
    claim(key: string, now: number, staleBefore: number): boolean;
    finish(key: string, update: JobFinish): void;
  }
  export interface JobTiming {
    readonly intervalMs: number;
    readonly jitterRatio?: number;
    readonly backoffInitialMs?: number;
    readonly backoffMaxMs?: number;
  }
  export type JobResult =
    | { readonly status: 'ok' }
    | { readonly status: 'skipped'; readonly reason: string }
    | { readonly status: 'failed'; readonly error: string; readonly retryAfterSeconds?: number };
  export type JobHandler = (job: JobRecord) => Promise<JobResult>;
  export interface TickReport {
    readonly considered: number;
    readonly ran: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
  }
  export function runDueJobs(options: {
    readonly store: JobStore;
    readonly handlers: Readonly<Record<string, JobHandler>>;
    readonly timings: Readonly<Record<string, JobTiming>>;
    readonly now: number;
    readonly staleRunMs?: number;
    readonly random?: () => number;
    readonly onError?: (key: string, error: unknown) => void;
  }): Promise<TickReport>;
  export const DEFAULT_STALE_RUN_MS: number;
}

declare module '@maverick-wall/core' {
  export type CivilDate = string;
  export function addDays(date: CivilDate, days: number): CivilDate;
  export function eachDate(from: CivilDate, to: CivilDate): CivilDate[];
  export function daysBetween(from: CivilDate, to: CivilDate): number;
  export function dayOfWeek(date: CivilDate): number;

  export interface ShiftType {
    readonly key: string;
    readonly label: string;
    readonly shortCode: string;
    readonly colorToken: string;
    readonly isWorking: boolean;
  }
  export interface ShiftOverride {
    readonly date: CivilDate;
    readonly shiftTypeKey: string | null;
    readonly note?: string;
  }
  export type ShiftPlan = Record<string, unknown> & { readonly kind: 'pattern' | 'calendar' };
  export interface ResolvedShift {
    readonly date: CivilDate;
    readonly shiftTypeKey: string | null;
    readonly source: string;
    readonly planId?: string;
    readonly note?: string;
  }
  export function resolveShifts(input: {
    readonly from: CivilDate;
    readonly to: CivilDate;
    readonly plans: readonly ShiftPlan[];
    readonly overrides: readonly ShiftOverride[];
    readonly titlesByDate?: ReadonlyMap<CivilDate, readonly string[]>;
    readonly shiftTypes?: readonly ShiftType[];
  }): ResolvedShift[];
}

declare module '@maverick-wall/core' {
  export const DEFAULT_SHIFT_TYPES: readonly {
    readonly key: string;
    readonly label: string;
    readonly shortCode: string;
    readonly colorToken: string;
    readonly isWorking: boolean;
  }[];
}
