import { Hono, type Context, type Next } from 'hono';
import { localDateOf } from '@maverick-wall/calendar';
import {
  issueDisplayToken,
  shortCodeHashMatches,
  verifyDisplayToken,
} from '../auth/tokens.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  createAuth,
  createSessionResolver,
  CLIENT_IP_HEADER,
  type AuthOptions,
} from '../auth/better-auth.js';
import {
  protectPrefix,
  refuseLateSignUp,
  requireSetupComplete,
  type GateDeps,
} from '../auth/session.js';
import { createSetupTokenHolder, registerSetupRoutes, type SetupTokenHolder } from './setup.js';
import { registerAdminRoutes } from './admin.js';
import { createStaticFiles, defaultDisplayDir, defaultFontsDir } from './static.js';
import { ingress, ingressPath, isTrustedIngress } from './ingress.js';
import { readImage } from '../api/media.js';
import { collectPanels, collectSignals } from '../modules/registry.js';
import { weatherModule } from '../modules/weather/index.js';
import { haModule } from '../modules/homeassistant/index.js';
import { externalPanelModules } from '../modules/external/index.js';
import { calendarModule } from '../modules/calendar/index.js';
import { evaluateInterrupts } from '@maverick-wall/core';
import { dismissInterrupt, readDismissals, readRules } from '../api/rules.js';
import { createLogBuffer, type LogBuffer } from '../logbuffer.js';
import { errorBlock, escapeHtml, page } from './html.js';
import { parse, text } from '../validation.js';
import type { Fetcher } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import { buildManifest, manifestEtag, type ManifestNotice } from '../api/manifest.js';
import {
  claimScreenPairing,
  countUsers,
  readEvents,
  readLayoutWidgets,
  effectiveDisplay,
  readHousehold,
  readLastSync,
  readPairableScreens,
  readPeople,
  readSchemaVersion,
  readScreens,
  readSetupState,
  readHouseholdUser,
  readShiftOverrides,
  readShiftPlans,
  readShiftTypes,
  readSources,
  touchScreen,
  type ScreenRow,
} from '../api/queries.js';
import type { SqliteDatabase } from '../db/open.js';

/**
 * The HTTP surface.
 *
 * Three audiences, three levels of trust. `/healthz` is open, because a
 * monitoring check that needs a credential is a monitoring check nobody sets
 * up. `/d/*` needs a display token. Everything under `/api` and `/admin` needs
 * a session, and lands in a later change.
 */

export const DEFAULT_DAYS_BEFORE = 1;
export const DEFAULT_DAYS_AFTER = 41;

/**
 * What boot learned from the supervisor about the wall's own address.
 *
 * `portMapped` is the load-bearing field: a number is a working host port, a
 * `null` is a port the household has turned off (and the one case the Screens
 * page must call out), and `undefined` is "no supervisor to ask" — a plain
 * `docker run`, where the old manual behaviour is exactly right.
 */
export interface WallAddress {
  readonly detected: string | undefined;
  readonly portMapped: number | null | undefined;
  /** True when the household set `base_url` themselves; their value wins. */
  readonly explicit: boolean;
}

export interface AppDeps {
  readonly db: SqliteDatabase;
  readonly appVersion: string;
  /** Notices from boot — a failed migration, a permissions warning. */
  readonly bootNotices: readonly ManifestNotice[];
  readonly now?: () => number;
  /**
   * Better Auth configuration.
   *
   * `baseUrl` is fixed for the process lifetime. Home Assistant ingress serves
   * this app from a path that varies per installation and is carried in a
   * header per request — `resolveBaseUrl` in `auth/better-auth.ts` computes
   * that, but nothing calls it yet, because there is no ingress add-on to
   * verify the result against. Wiring it in now would be exactly the kind of
   * unexecuted code this project has been burned by before.
   */
  readonly auth: Pick<AuthOptions, 'secret' | 'baseUrl'>;
  /**
   * The address the request actually came from.
   *
   * Defaults to the socket. Injectable because `getConnInfo` needs a real Node
   * server underneath and there is none when a test calls `app.fetch`
   * directly — and because a test that cannot vary the address cannot show
   * that rate limiting is per-client at all.
   */
  readonly clientAddress?: (c: Context) => string | undefined;
  /**
   * When to trust a Home Assistant ingress request as an already-signed-in
   * household, so the settings do not ask for a second login the supervisor
   * has already done.
   *
   * `isAddon` gates the whole thing — off, and the behaviour is exactly as
   * before. `sources` is the set of socket addresses a genuine ingress request
   * can come from: the supervisor's fixed address on the internal network.
   * Defaults from the environment (`SUPERVISOR_TOKEN` present, and
   * `INGRESS_TRUST_SOURCE` or the documented `172.30.32.2`); injectable so a
   * test can prove both the trusted and the forged case without a supervisor.
   */
  readonly ingressTrust?: { readonly isAddon: boolean; readonly sources: readonly string[] };
  /** Encrypts calendar URLs added through the wizard. */
  readonly keyring: Keyring;
  /** Tests a feed before the wizard stores it. */
  readonly fetcher: Fetcher;
  /**
   * The bootstrap setup code.
   *
   * Supplied by the caller rather than created here, because boot has to print
   * it before anyone loads a page — a holder owned by the app would not issue
   * one until the first request, which is far too late to reach the log the
   * household is reading.
   */
  readonly setupToken?: SetupTokenHolder;
  /**
   * Where the built display bundle lives.
   *
   * Defaults to the sibling of the compiled server, resolved from this
   * module's own URL rather than the working directory — the same trap that
   * once split one installation into two databases.
   */
  readonly displayDir?: string;
  /**
   * Where the self-hosted admin fonts live. Defaults to the sibling of the
   * compiled server; `FONTS_DIR` overrides it in the flattened image.
   */
  readonly fontsDir?: string;
  /** Where the database and the encryption key live. */
  readonly dataDir: string;
  /**
   * What the supervisor knows about how a wall screen reaches this add-on,
   * detected once at boot. Absent on plain `docker run`, where there is no
   * supervisor to ask. The Screens page uses it to fill the pairing address in
   * and to say plainly when the display port is turned off.
   */
  readonly wallAddress?: WallAddress;
  /** For the uptime figure in diagnostics. Defaults to now. */
  readonly startedAt?: number;
  /**
   * The log the System screen tails.
   *
   * Supplied by boot, because it has to be capturing before anything worth
   * reading has been logged — one created here would start empty at the first
   * request and miss every line about why the start went badly.
   */
  readonly log?: LogBuffer;
}

/**
 * A Buffer as something Hono will send.
 *
 * `c.body` takes an ArrayBuffer, and a Buffer is a view onto a pooled one, so
 * handing over `.buffer` directly would send whatever else Node happens to
 * have parked in that pool alongside it.
 */
export function bytesOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const DISPLAY_COOKIE = 'mw_display';

/** Ten years. A wall is paired once and left alone; see the `/pair` routes. */
const DISPLAY_COOKIE_ATTRS = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000';

/** The pairing-code guess limit: how many, and over how long. */
const PAIR_WINDOW_MS = 5 * 60_000;
const PAIR_MAX_ATTEMPTS = 20;

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Identify the screen behind a request.
 *
 * A token may arrive as a bearer header or as a cookie. The cookie exists
 * because a kiosk browser loads `/` with no way to set headers; it is set once
 * during pairing so the token never has to appear in a URL again.
 */
function authenticateScreen(c: Context, screens: readonly ScreenRow[]): ScreenRow | undefined {
  const authorization = c.req.header('authorization');
  const bearer = authorization?.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : undefined;
  const presented = bearer ?? cookieValue(c.req.header('cookie'), DISPLAY_COOKIE);
  if (!presented) return undefined;

  // Linear scan over every screen. A household has a handful, and comparing
  // against each is what keeps the comparison constant-time per candidate
  // rather than turning the token into a lookup key.
  return screens.find((screen) => verifyDisplayToken(presented, screen.tokenHash));
}

/**
 * Every panel module, in one list.
 *
 * The manifest asks each for its slice, boot registers their jobs from the
 * same list, and the Display screen offers their blocks from it too — so
 * adding a module is one entry rather than three edits in three files.
 */
export const MODULES = [weatherModule, haModule, calendarModule];

/**
 * The wall clock in a zone, as `HH:MM`.
 *
 * Lives here rather than in core, because core may not reach for `Intl` — rule
 * one, and `globals.d.ts` is the complete list of what it may use. From `Intl`
 * rather than arithmetic for the same reason recurrence is: the offset on a
 * given night is a fact about a timezone database, and a household on the wrong
 * side of a clock change would otherwise get their overnight rules an hour late
 * twice a year.
 */
export function localClock(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));
  } catch {
    // An unusable zone must not disarm every rule that has a window. UTC is
    // wrong by hours; refusing to evaluate is wrong always.
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at));
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());

  const staticFiles = createStaticFiles(deps.displayDir ?? defaultDisplayDir());
  const fontFiles = createStaticFiles(deps.fontsDir ?? defaultFontsDir());

  const auth = createAuth({ db: deps.db, secret: deps.auth.secret, baseUrl: deps.auth.baseUrl });

  /*
   * The real socket peer, for every decision that must not trust a header:
   * rate limiting, and whether an ingress request is genuinely the supervisor.
   * Defined here rather than lower down because the session gate depends on it.
   */
  const clientAddress =
    deps.clientAddress ??
    ((c: Context): string | undefined => {
      try {
        return getConnInfo(c).remote.address;
      } catch {
        // No Node server underneath (a test calling app.fetch). Rate limiting
        // falls back to a shared bucket; ingress trust fails closed to login.
        return undefined;
      }
    });

  /*
   * A fixed-window limit on pairing-code guesses.
   *
   * The code is single-use and time-boxed, which is the real defence — but it
   * is only ~38 bits, and a wall-side endpoint anyone on the LAN can reach
   * should not let a script sit and guess. Twenty tries in five minutes is far
   * more than a person fumbling a code off a screen needs and far too few to
   * search the space. Per app instance, not module-global, so tests keyed to
   * one address stay independent — the same reason the auth counters are.
   */
  const pairAttempts = new Map<string, { count: number; resetAt: number }>();
  const pairRateLimited = (address: string | undefined, at: number): boolean => {
    const key = address ?? 'shared';
    const bucket = pairAttempts.get(key);
    if (bucket === undefined || at > bucket.resetAt) {
      pairAttempts.set(key, { count: 1, resetAt: at + PAIR_WINDOW_MS });
      return false;
    }
    bucket.count += 1;
    return bucket.count > PAIR_MAX_ATTEMPTS;
  };

  /*
   * When to accept a Home Assistant login in place of ours. Off unless we are
   * an add-on, and pinned to the supervisor's socket address — see
   * `isTrustedIngress`. Read once, from the caller or the environment.
   */
  const ingressTrust = deps.ingressTrust ?? {
    isAddon: process.env['SUPERVISOR_TOKEN'] !== undefined,
    sources: (process.env['INGRESS_TRUST_SOURCE'] ?? '172.30.32.2')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  };
  const trustedSources = new Set(ingressTrust.sources);

  const gateDeps: GateDeps = {
    sessions: createSessionResolver(auth),
    setupState: () => readSetupState(deps.db),
    ingressUser: (c: Context) =>
      isTrustedIngress(c, clientAddress(c), { isAddon: ingressTrust.isAddon, sources: trustedSources })
        ? readHouseholdUser(deps.db)
        : undefined,
  };

  /*
   * Held back until the wizard finishes, everywhere at once.
   *
   * Registered first so it cannot be outflanked by a route added below it,
   * and made to answer for its own exceptions rather than depending on where
   * it sits in the file. `/healthz`, `/d/*` and `/setup` pass through: a
   * stalled setup has to stay diagnosable, and a wall that says "not set up
   * yet" beats one showing nothing at all.
   */
  /**
   * Refuse a state-changing request that came from somebody else's page.
   *
   * The session and setup cookies are `SameSite=Lax`, which already stops a
   * browser attaching them to a cross-site POST, and that is the main
   * mitigation. This is the second one, and it exists because the forms here
   * are handled by this application rather than by Better Auth — the internal
   * call stamps an origin the library will trust, so the library's own check
   * no longer stands between a forged post and the account it would create.
   *
   * Only when an `Origin` is present and disagrees. A browser always sends one
   * on a cross-site POST; a missing header means a client that is not a
   * browser, which is not the thing being defended against here.
   *
   * Whoever wires Home Assistant ingress: the browser's origin will be the
   * supervisor's, and this compares against the address the request arrived
   * on. That needs handling here at the same time.
   */
  /*
   * Registered before the guard below, because it decides what that guard sees
   * and because every response it rewrites has to be rewritten on the way out.
   */
  app.use('*', ingress());

  /*
   * The one fact this whole feature turns on, printed once so it can be
   * confirmed on real hardware rather than assumed.
   *
   * The trusted source is the supervisor's address, and a wrong guess fails
   * closed to the normal login — so this line is how a household (or whoever is
   * next) checks it is right: the first ingress request logs where it actually
   * came from and whether that was trusted. If it says `trusted: no`, the
   * address printed is the one to add to `INGRESS_TRUST_SOURCE`. Addresses
   * only, never a path or a token — rule six.
   */
  if (ingressTrust.isAddon) {
    let announced = false;
    app.use('*', async (c: Context, next: Next): Promise<void> => {
      if (!announced && ingressPath(c) !== '') {
        announced = true;
        const addr = clientAddress(c) ?? 'unknown';
        const trusted = isTrustedIngress(c, clientAddress(c), {
          isAddon: ingressTrust.isAddon,
          sources: trustedSources,
        });
        console.log(`[ingress] first request from ${addr}; trusted supervisor source: ${trusted ? 'yes' : 'no'}`);
      }
      await next();
    });
  }

  app.use('*', async (c: Context, next: Next): Promise<Response | void> => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      await next();
      return;
    }
    /*
     * Under ingress the browser's origin is Home Assistant's, not ours, so
     * this guard would refuse every form post in the add-on.
     *
     * The supervisor is the trust boundary there: it will not forward a
     * request that does not already carry a valid Home Assistant session, and
     * it is the only thing that can set this header on the way in — nothing
     * outside the container's network can reach the port it forwards from.
     * The `SameSite=Lax` cookie is still the primary mitigation in both cases.
     */
    if (ingressPath(c) !== '') {
      await next();
      return;
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return c.json(
        {
          error: 'cross-origin',
          message: 'That request came from another site and was refused.',
        },
        403,
      );
    }
    await next();
  });

  app.use('*', requireSetupComplete(gateDeps));

  /**
   * Unauthenticated on purpose.
   *
   * Reveals only whether the process is alive and roughly how fresh its data
   * is — enough for a Docker healthcheck or an uptime monitor, nothing that
   * identifies a household or its calendars.
   */
  app.get('/healthz', (c: Context) => {
    let schemaVersion = 0;
    let lastSync: number | null = null;
    let ok = true;
    try {
      schemaVersion = readSchemaVersion(deps.db);
      lastSync = readLastSync(deps.db);
    } catch {
      ok = false;
    }
    return c.json({
      ok,
      version: deps.appVersion,
      schemaVersion,
      lastSync,
      // Lets a display detect clock drift before it has a token.
      serverTime: now(),
    });
  });

  const requireScreen = async (c: Context, next: Next): Promise<Response | void> => {
    const screens = readScreens(deps.db);
    const screen = authenticateScreen(c, screens);
    if (!screen) {
      return c.json(
        { error: 'unauthorized', message: 'This screen is not paired.' },
        401,
      );
    }
    c.set('screen', screen);
    await next();
  };

  app.use('/d/*', requireScreen);

  /**
   * Uploaded pictures, behind the display token like the manifest itself.
   *
   * `/d/*` already requires a paired screen, so this inherits that gate. A
   * family's photographs must not be readable by anything on the network that
   * happens to know a filename.
   */
  app.get('/d/media/:name', (c: Context) => {
    const image = readImage(deps.dataDir, c.req.param('name') ?? '');
    if (image === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('content-type', image.contentType);
    // The type is sniffed from the bytes; this stops a browser deciding it
    // knows better and treating an image as something executable.
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(bytesOf(image.bytes));
  });

  /**
   * Clearing an interrupt from the wall.
   *
   * Behind the display token, and household-wide rather than per screen — a
   * kitchen tablet and a hall television must not disagree about whether the
   * garage is still worth mentioning. That was the open question when
   * interrupts were first sketched, and this is the answer: one record, every
   * screen, and `reassertAfterSec` is what stops "yes, I know" meaning "never
   * mention it again" while the storm is still overhead.
   */
  app.post('/d/interrupts/dismiss', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const key = typeof body['key'] === 'string' ? body['key'].trim() : '';
    // `ruleId:signalKey`, and nothing longer than the ids that make it up.
    if (key === '' || key.length > 400 || !key.includes(':')) {
      return c.json({ error: 'bad-key' }, 400);
    }

    /*
     * Only a rule that said it may be dismissed.
     *
     * The wall hides the button for the rest, but the button is not the
     * control — an Extreme warning must not be clearable by anything that can
     * reach this endpoint, and the display token is on the wall.
     */
    const ruleId = key.slice(0, key.indexOf(':'));
    const rule = readRules(deps.db).find((candidate) => candidate.id === ruleId);
    if (rule === undefined || !rule.dismissible) {
      return c.json({ error: 'not-dismissible' }, 403);
    }

    /*
     * Stored under the signal, not the rule.
     *
     * The wire format names both because the rule is what decides whether this
     * may be cleared at all — but a household acknowledges a *thing*, and
     * several rules match one warning. Storing per rule meant pressing OK
     * promoted the next rule down and the wall carried on regardless.
     */
    dismissInterrupt(deps.db, key.slice(key.indexOf(':') + 1), now());
    return c.json({ ok: true });
  });

  /**
   * The manifest, built for a given screen.
   *
   * Shared by the wall (a paired screen) and the layout editor's preview (a
   * default screen, behind the session), so the preview draws from exactly the
   * same document a wall does and cannot drift from what the wall shows.
   */
  const buildDisplayManifest = (screenLike: {
    readonly id?: string;
    readonly timezone: string | null;
    readonly orientation: string;
    readonly rotation: number;
    readonly allowDismiss: boolean;
    readonly theme: string | null;
    readonly daytimeTheme: string | null;
    readonly daytimeStartsAt: string | null;
    readonly daytimeEndsAt: string | null;
    readonly displayTodayEvents?: number | null;
    readonly displayNextDays?: number | null;
    readonly displayHorizonWeeks?: number | null;
    readonly displayBlocks?: string | null;
    readonly layoutMode?: string | null;
    readonly layoutAspect?: number | null;
  }) => {
    const at = now();
    const household = readHousehold(deps.db);
    const today = localDateOf(at, household.timezone);
    const from = shiftDate(today, -DEFAULT_DAYS_BEFORE);
    const to = shiftDate(today, DEFAULT_DAYS_AFTER);

    /*
     * The zone this particular screen is in — the same resolution the manifest
     * does, hoisted because an interrupt limited to the night has to mean night
     * where the screen is hanging.
     */
    const timezone =
      screenLike.timezone !== null && screenLike.timezone !== ''
        ? screenLike.timezone
        : household.timezone;

    // This wall's effective display settings — its own overrides, or the
    // household's — and which canvas of widgets to read: its own, or the
    // shared default. One resolver, so every surface agrees.
    const { household: effective, layoutOwner } = effectiveDisplay(household, screenLike);

    // Built once and shared: the panels and the signals come from the same
    // instant, so a wall never draws a reading from one poll beside an
    // interrupt evaluated against another.
    const moduleContext = { db: deps.db, fetcher: deps.fetcher, keyring: deps.keyring, now: at, timezone };

    return buildManifest({
      household: effective,
      layoutWidgets: readLayoutWidgets(deps.db, layoutOwner),
      events: readEvents(deps.db, from, to),
      sources: readSources(deps.db),
      people: readPeople(deps.db),
      shiftTypes: readShiftTypes(deps.db),
      shiftPlans: readShiftPlans(deps.db),
      shiftOverrides: readShiftOverrides(deps.db, from, to),
      today,
      daysBefore: DEFAULT_DAYS_BEFORE,
      daysAfter: DEFAULT_DAYS_AFTER,
      now: at,
      appVersion: deps.appVersion,
      // Collected here rather than inside assembly, which stays pure and does
      // no I/O: every module reads its own cache, filled by its own job. The
      // registered third-party modules join the first-party ones, so they go
      // through the same isolation and ordering.
      panels: collectPanels([...MODULES, ...externalPanelModules(deps.db)], moduleContext),
      /*
       * Evaluated per poll, from stored signals and stored rules — every wall
       * reads the same document, including which interrupts have been cleared.
       */
      interrupts: evaluateInterrupts({
        rules: readRules(deps.db),
        signals: collectSignals(MODULES, moduleContext),
        now: at,
        // Worked out here because core may not reach for `Intl` — rule one.
        localHhmm: localClock(at, timezone),
        dismissedAt: readDismissals(deps.db),
      }).active,
      screen: {
        orientation: screenLike.orientation,
        rotation: screenLike.rotation,
        allowDismiss: screenLike.allowDismiss,
        theme: screenLike.theme,
        timezone: screenLike.timezone,
        daytimeTheme: screenLike.daytimeTheme,
        daytimeStartsAt: screenLike.daytimeStartsAt,
        daytimeEndsAt: screenLike.daytimeEndsAt,
      },
      notices: deps.bootNotices,
    });
  };

  app.get('/d/manifest', (c: Context) => {
    const screen = c.get('screen') as ScreenRow;
    const manifest = buildDisplayManifest({
      // The document is already screen-specific — served behind a display
      // token — so how that screen is hung, and anything it has arranged for
      // itself, travels with it.
      id: screen.id,
      timezone: screen.timezone,
      orientation: screen.orientation,
      rotation: screen.rotation,
      allowDismiss: screen.allowDismiss === 1,
      theme: screen.theme,
      daytimeTheme: screen.daytimeTheme,
      daytimeStartsAt: screen.daytimeStartsAt,
      daytimeEndsAt: screen.daytimeEndsAt,
      displayTodayEvents: screen.displayTodayEvents,
      displayNextDays: screen.displayNextDays,
      displayHorizonWeeks: screen.displayHorizonWeeks,
      displayBlocks: screen.displayBlocks,
      layoutMode: screen.layoutMode,
      layoutAspect: screen.layoutAspect,
    });

    // Recorded after building, so a screen that is failing to render still
    // shows as last seen. Failing to update this would make a broken display
    // look like an absent one.
    try {
      touchScreen(deps.db, screen.id, null, c.req.header('user-agent') ?? null);
    } catch {
      // Diagnostics only; never worth failing a poll over.
    }

    const etag = manifestEtag(manifest);
    // Server time goes in a header as well as the body, so a 304 still
    // carries it. Clock sync must not depend on the body being sent.
    c.header('x-server-time', String(manifest.generatedAt));
    c.header('cache-control', 'no-cache');

    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { etag });
    }

    c.header('etag', etag);
    return c.json(manifest);
  });

  /**
   * No public registration. The first account is the only one Better Auth's
   * own sign-up route will ever create; after that this answers 403 before the
   * library sees the request. Registered ahead of the catch-all below so it
   * runs first and falls through via `next()` — the same composition already
   * proven by `requireScreen` guarding `/d/manifest`.
   */
  app.use('/api/auth/sign-up/email', refuseLateSignUp(gateDeps));

  /**
   * Everything else Better Auth handles itself: sign-in, sign-out, session
   * lookup, CSRF, rate limiting. Reimplementing any of that here would be the
   * mistake rule five exists to prevent.
   */
  app.all('/api/auth/*', (c: Context) => {
    const headers = new Headers(c.req.raw.headers);
    // Deleted before it is set, so a client that sends this header cannot keep
    // its own value when the socket address is unavailable.
    headers.delete(CLIENT_IP_HEADER);
    const address = clientAddress(c);
    if (address !== undefined && address !== '') headers.set(CLIENT_IP_HEADER, address);
    return auth.handler(new Request(c.req.raw, { headers }));
  });

  /**
   * Call Better Auth from inside a handler.
   *
   * Every internal call goes through here so none of them can forget the
   * client address — one did, and the wizard's own sign-up silently shared a
   * rate-limit bucket with every other caller until a test could not create a
   * fourth account. The cookie is forwarded too, because sign-out needs to
   * know which session it is ending.
   */
  const authApi = (c: Context, path: string, body: unknown = {}): Promise<Response> =>
    auth.handler(
      new Request(new URL(path, c.req.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CLIENT_IP_HEADER]: clientAddress(c) ?? '',
          cookie: c.req.header('cookie') ?? '',
          // Better Auth refuses a POST with no Origin. This request really is
          // same-origin — this server made it — and saying so is honest
          // rather than a way around the check.
          origin: new URL(c.req.url).origin,
        },
        body: JSON.stringify(body),
      }),
    );

  /**
   * The sign-in form.
   *
   * Server-rendered for the same reason the wizard is: this is the way back in
   * when something else is broken. It posts to itself rather than to Better
   * Auth directly because a plain form sends url-encoded fields and the API
   * expects JSON — and a form that needs script to submit is one that fails on
   * exactly the locked-down browser most likely to be pointed at a wall.
   */
  app.get('/admin/sign-in', (c: Context) => c.html(signInPage()));

  app.post('/admin/sign-in', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    const response = await authApi(c, '/api/auth/sign-in/email', { email, password });

    if (response.status >= 400) {
      // Deliberately the same message for an unknown address and a wrong
      // password. Distinguishing them tells anyone who can reach the port
      // which email address is the household's.
      const message =
        response.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That email address and password do not match.';
      return c.html(signInPage(message, email), response.status === 429 ? 429 : 401);
    }

    for (const cookie of response.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true });
    }
    return c.redirect('/admin', 302);
  });

  protectPrefix(app, '/api', gateDeps);
  protectPrefix(app, '/admin', gateDeps);

  registerAdminRoutes(app, {
    db: deps.db,
    keyring: deps.keyring,
    fetcher: deps.fetcher,
    signOut: (c: Context) => authApi(c, '/api/auth/sign-out'),
    appVersion: deps.appVersion,
    baseUrl: deps.auth.baseUrl,
    ...(deps.wallAddress !== undefined ? { wallAddress: deps.wallAddress } : {}),
    previewManifest: (screenId?: string | null) => {
      // A named wall previews as itself — its zone, its density, its own
      // canvas — so the editor shows what that screen will actually draw. The
      // default (no id, or an unknown one) previews the shared settings.
      const screen =
        screenId === null || screenId === undefined
          ? undefined
          : readScreens(deps.db).find((s) => s.id === screenId);
      if (screen !== undefined) {
        return buildDisplayManifest({
          id: screen.id,
          timezone: screen.timezone,
          orientation: screen.orientation,
          rotation: screen.rotation,
          allowDismiss: screen.allowDismiss === 1,
          theme: screen.theme,
          daytimeTheme: screen.daytimeTheme,
          daytimeStartsAt: screen.daytimeStartsAt,
          daytimeEndsAt: screen.daytimeEndsAt,
          displayTodayEvents: screen.displayTodayEvents,
          displayNextDays: screen.displayNextDays,
          displayHorizonWeeks: screen.displayHorizonWeeks,
          displayBlocks: screen.displayBlocks,
          layoutMode: screen.layoutMode,
          layoutAspect: screen.layoutAspect,
        });
      }
      return buildDisplayManifest({
        timezone: null,
        orientation: 'portrait',
        rotation: 0,
        allowDismiss: false,
        theme: null,
        daytimeTheme: null,
        daytimeStartsAt: null,
        daytimeEndsAt: null,
      });
    },
    dataDir: deps.dataDir,
    startedAt: deps.startedAt ?? now(),
    log: deps.log ?? createLogBuffer(),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  /**
   * Pairing. The QR code on the admin screen points here.
   *
   * Exchanges a token in the URL for an HttpOnly cookie, then redirects, so the
   * token appears once at pairing and never again in a URL, a log, or a
   * browser history entry that someone later screenshots.
   */
  app.get('/pair', (c: Context) => {
    const token = c.req.query('token');
    if (!token) {
      return c.json({ error: 'missing-token', message: 'No pairing token in the link.' }, 400);
    }
    const screen = readScreens(deps.db).find((candidate) =>
      verifyDisplayToken(token, candidate.tokenHash),
    );
    if (!screen) {
      return c.json({ error: 'unknown-token', message: 'That pairing link is not valid.' }, 401);
    }

    // Ten years. A wall display is paired once and then left alone; an expiry
    // would mean a screen going blank at some arbitrary future moment with
    // nobody around to notice why.
    c.header('set-cookie', `${DISPLAY_COOKIE}=${token}; ${DISPLAY_COOKIE_ATTRS}`);
    return c.redirect('/', 302);
  });

  /**
   * Pairing by code, for a screen with no camera.
   *
   * A television cannot scan the QR, and typing the whole token URL on a remote
   * is miserable — so the screen itself offers a field, and this is where it
   * posts the short code from the admin's pairing page. On a match the screen is
   * rotated onto a fresh token and handed the same cookie the QR path sets, so
   * everything downstream is identical however the wall was paired.
   *
   * The reply is JSON, not a redirect: the display posts this from script and
   * reloads itself on success. The token never appears in a URL here either.
   */
  app.post('/pair', async (c: Context) => {
    // The socket peer, never a header — a forged `X-Forwarded-For` must not let
    // a guesser reset somebody else's bucket or hide behind theirs.
    if (pairRateLimited(clientAddress(c), now())) {
      return c.json(
        { error: 'rate-limited', message: 'Too many tries. Wait a few minutes, then try again.' },
        429,
      );
    }

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(text('A pairing code', 32), body['code']);
    // One generic message for every failure below: a wrong code, an expired
    // code and an already-spent code are indistinguishable to whoever is typing,
    // and telling them apart only helps somebody guessing.
    const rejected = { error: 'unknown-code', message: 'That code is not right, or it has expired.' };
    if (!shaped.ok) return c.json(rejected, 400);

    const candidate = readPairableScreens(deps.db, now()).find((screen) =>
      shortCodeHashMatches(screen.pairingCodeHash, shaped.value),
    );
    if (candidate === undefined) return c.json(rejected, 400);

    // A fresh token, so the code-paired screen is indistinguishable from a
    // QR-paired one and the QR's token (if it was ever shown) stops working.
    const issued = issueDisplayToken();
    const claimed = claimScreenPairing(
      deps.db,
      candidate.id,
      candidate.pairingCodeHash,
      issued.tokenHash,
    );
    // Lost the race with another submission of the same code — it is spent now.
    if (!claimed) return c.json(rejected, 400);

    c.header('set-cookie', `${DISPLAY_COOKIE}=${issued.token}; ${DISPLAY_COOKIE_ATTRS}`);
    return c.json({ ok: true });
  });

  /**
   * The display bundle.
   *
   * Open, like `/d/*` and for the same reason: the screen carries its own
   * token and the manifest behind it is what is actually protected. Serving
   * the shell to anyone on the LAN gives away nothing, and putting it behind
   * the session gate would mean a wall that cannot draw until somebody signs
   * in on it, which is the one thing these screens cannot do.
   */
  app.get('/assets/:name', (c: Context) => {
    const file = staticFiles.read(c.req.param('name') ?? '');
    if (file === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('content-type', file.contentType);
    c.header('cache-control', 'no-cache');
    return c.body(bytesOf(file.body));
  });

  /*
   * The self-hosted admin fonts, on their own path and directory.
   *
   * Rule three: the admin loads no web font, so Roboto Condensed ships in the
   * image and is served same-origin. Unlike the display bundle these are
   * content-addressed by nothing that changes, so they carry a long immutable
   * cache — a woff2 that never changes is cheap to keep for a year.
   */
  app.get('/assets/fonts/:name', (c: Context) => {
    const file = fontFiles.read(c.req.param('name') ?? '');
    if (file === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('content-type', file.contentType);
    c.header('cache-control', 'public, max-age=31536000, immutable');
    return c.body(bytesOf(file.body));
  });

  /**
   * The service worker, at the root and only at the root.
   *
   * A worker's scope is the path it is served from, so one delivered from
   * `/assets/` could only ever control `/assets/` — which is not where the
   * page is. Same-origin, no cache: an old worker that outlives its bundle is
   * a wall serving a shell nobody can update.
   */
  app.get('/sw.js', (c: Context) => {
    const worker = staticFiles.read('sw.js');
    if (worker === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-cache');
    c.header('service-worker-allowed', '/');
    return c.body(bytesOf(worker.body));
  });

  app.get('/', (c: Context) => {
    /*
     * Under ingress, the root means the admin screens.
     *
     * A wall display never comes through ingress — it has no Home Assistant
     * session and connects to the add-on's port directly with a display token.
     * So somebody arriving here has clicked the add-on in the sidebar, and
     * what they want is the settings, not a calendar that cannot pair itself.
     */
    if (ingressPath(c) !== '') return c.redirect('/admin', 302);

    const shell = staticFiles.read('index.html');
    if (shell !== undefined) {
      c.header('content-type', 'text/html; charset=utf-8');
      c.header('cache-control', 'no-cache');
      return c.body(bytesOf(shell.body));
    }

    // Not built. Say so rather than 404 — a blank screen is the one outcome to
    // avoid, and "the bundle is missing" is a fault somebody can act on.
    const users = countUsers(deps.db);
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Maverick Wall</title>` +
        `<body style="font:16px system-ui;padding:2rem;background:#0B0E11;color:#E9EEF4">` +
        `<h1>Maverick Wall</h1>` +
        `<p>The server is running, but the display bundle was not found at ` +
        `<code>${escapeHtml(staticFiles.directory)}</code>.</p>` +
        `<p>Build it with <code>pnpm --filter @maverick-wall/display build</code>.</p>` +
        `<p>${users === 0 ? 'No account has been created either. Check the container logs for the setup link.' : 'The admin interface is at <code>/admin</code>.'}</p>`,
    );
  });

  registerSetupRoutes(app, {
    db: deps.db,
    keyring: deps.keyring,
    fetcher: deps.fetcher,
    sessions: gateDeps.sessions,
    setupToken: deps.setupToken ?? createSetupTokenHolder((): void => {}),
    signUp: (c: Context, input) => authApi(c, '/api/auth/sign-up/email', input),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  app.notFound((c: Context) => c.json({ error: 'not-found', path: c.req.path }, 404));

  app.onError((error: Error, c: Context) => {
    // Never leak internals to a display. The detail goes to the log.
    // eslint-disable-next-line no-console
    console.error('[http]', error.message);
    return c.json({ error: 'internal', message: 'Something went wrong on the server.' }, 500);
  });

  return app;
}

function signInPage(error?: string, email = ''): string {
  return page({
    title: 'Sign in — Maverick Wall',
    heading: 'Sign in',
    body:
      (error === undefined ? '' : errorBlock(error)) +
      `<form method="post" action="admin/sign-in">` +
      `<label for="email">Email address</label>` +
      `<input id="email" name="email" type="email" required autocomplete="username" value="${escapeHtml(email)}">` +
      `<label for="password">Password</label>` +
      `<input id="password" name="password" type="password" required autocomplete="current-password">` +
      `<button type="submit">Sign in</button></form>`,
  });
}

/** Civil date arithmetic without pulling core in for one call. */
function shiftDate(date: string, days: number): string {
  const parts = date.split('-').map(Number);
  const ms = Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1) + days * 86_400_000;
  const shifted = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
