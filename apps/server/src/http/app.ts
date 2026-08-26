import { Hono, type Context, type Next } from 'hono';
import { localDateOf } from '@maverick-wall/calendar';
import {
  issueDisplayToken,
  shortCodeHashMatches,
  verifyDisplayToken,
} from '../auth/tokens.js';
import {
  DISPLAY_COOKIE,
  DISPLAY_COOKIE_ATTRS,
  authenticateScreenToken,
  presentedDisplayToken,
} from '../auth/screen-token.js';
import { createDeviceFlowStore, type DeviceFlowStore } from '../auth/device-flow.js';
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
import { contentEtag, createStaticFiles, defaultDisplayDir, defaultFontsDir } from './static.js';
import { ingress, ingressPath, isTrustedIngress } from './ingress.js';
import { effectiveOrigin, isSecureRequest } from './forwarded.js';
import { readImage } from '../api/media.js';
import { collectPanels, collectSignals } from '../modules/registry.js';
import { allModules, householdSetUp, MODULES } from '../modules/index.js';
import { activeOn, localToday, readChores, setChoreDone } from '../api/chores.js';
import { evaluateInterrupts } from '@maverick-wall/core';
import { dismissInterrupt, readDismissals, readRules } from '../api/rules.js';
import { createLogBuffer, type LogBuffer } from '../logbuffer.js';
import { ADMIN_STYLESHEET, errorBlock, escapeHtml, page, textField } from './html.js';
import { parse, text } from '../validation.js';
import type { Fetcher } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import {
  buildManifest,
  keepWidgetsWithSomethingToSay,
  manifestEtag,
  RUN_WINDOW_DAYS,
  type Manifest,
  type ManifestNotice,
} from '../api/manifest.js';
import { epaperOrientation, renderScreenFrame } from '../epaper/frame.js';
import { encodePng1bit } from '../epaper/png.js';
import { resolveTheme } from '../api/themes.js';
import {
  claimScreenPairing,
  countUsers,
  readEvents,
  readLayoutWidgets,
  panelCanvasOwner,
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
  recordScreenViewport,
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
  /**
   * The socket addresses a TLS-terminating reverse proxy connects from.
   *
   * When a request's real socket source is one of these, its
   * `X-Forwarded-Proto` is honoured — so the cross-origin guard and the display
   * cookie's `Secure` follow the scheme the browser actually used, not the http
   * the container sees behind the proxy. Empty by default (the header is
   * ignored), so a direct-to-box or plain `docker run` household is unaffected.
   * Defaults from `TRUSTED_PROXY_SOURCE`; injectable so a test proves both the
   * trusted and the forged case without a proxy. See `http/forwarded.ts`.
   */
  readonly trustedProxySources?: readonly string[];
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
  /**
   * Hand the WebSocket push server the very builder the `/d/manifest` route
   * uses.
   *
   * Called once during construction with a function that builds a paired
   * screen's manifest. The push hub derives its etag and interrupt set from
   * exactly that document, so a pushed `MANIFEST_CHANGED` can never disagree
   * with what the next poll returns — the drift class of bug, designed out.
   *
   * Optional: a test that only drives `app.fetch` has no socket and passes no
   * callback, and the route behaves exactly as before.
   */
  readonly onManifestBuilder?: (build: (screen: ScreenRow) => Manifest) => void;
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

/** The pairing-code guess limit: how many, and over how long. */
const PAIR_WINDOW_MS = 5 * 60_000;
const PAIR_MAX_ATTEMPTS = 20;

/** `ADMIN_STYLESHEET` is a module constant, so its bytes never change at runtime. */
const ADMIN_STYLESHEET_ETAG = contentEtag(Buffer.from(ADMIN_STYLESHEET, 'utf8'));

/**
 * Identify the screen behind a request.
 *
 * A token may arrive as a bearer header or as a cookie. The cookie exists
 * because a kiosk browser loads `/` with no way to set headers; it is set once
 * during pairing so the token never has to appear in a URL again. The rule
 * itself lives in `auth/screen-token.ts` so the WebSocket push server, which
 * sees a raw Node upgrade rather than a Hono context, checks it identically.
 */
function authenticateScreen(c: Context, screens: readonly ScreenRow[]): ScreenRow | undefined {
  return authenticateScreenToken(screens, {
    authorization: c.req.header('authorization'),
    cookie: c.req.header('cookie'),
  });
}

/**
 * Every panel module, in one list — re-exported from `modules/index.ts`, which
 * is where it now lives so that anything outside the request path (`main.ts`'s
 * job registration, the admin's panel preview) can reach it without importing
 * the whole application.
 */
export { MODULES };

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
   * The device-authorization pairing store, and a separate rate limit on
   * *starting* a flow. The poll route is deliberately not limited this way — a
   * screen is meant to poll every few seconds, and the device code it polls with
   * is 32 bytes, so there is nothing to guess. What an unauthenticated caller
   * could abuse is `device-start`, by filling the pending map; that is what the
   * per-address limit and the store's own `MAX_PENDING` ceiling bound together.
   * Shared with the admin approve route through `AdminDeps` so both halves of
   * one pairing see the same pending entry.
   */
  const deviceFlow: DeviceFlowStore = createDeviceFlowStore();
  const deviceStartAttempts = new Map<string, { count: number; resetAt: number }>();
  const deviceStartRateLimited = (address: string | undefined, at: number): boolean => {
    const key = address ?? 'shared';
    const bucket = deviceStartAttempts.get(key);
    if (bucket === undefined || at > bucket.resetAt) {
      deviceStartAttempts.set(key, { count: 1, resetAt: at + PAIR_WINDOW_MS });
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

  /*
   * The reverse-proxy sources whose `X-Forwarded-Proto` we honour. Read once,
   * from the caller or the environment; empty means the header is ignored, so
   * the common direct-to-box case runs exactly as before. See `forwarded.ts`.
   */
  const trustedProxies = new Set(
    deps.trustedProxySources ??
      (process.env['TRUSTED_PROXY_SOURCE'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
  );

  /*
   * The display cookie, with `Secure` added only when the browser reached us
   * over HTTPS. Never unconditional: an unconditional `Secure` strips the
   * cookie from every plain-http wall screen — the ordinary LAN case — and a
   * screen that cannot keep its display cookie cannot pair (rule nine). Both
   * `/pair` paths mint the cookie through here so neither can forget the rule.
   */
  const displayCookie = (token: string, c: Context): string => {
    const secure = isSecureRequest(c, clientAddress(c), trustedProxies) ? '; Secure' : '';
    return `${DISPLAY_COOKIE}=${token}; ${DISPLAY_COOKIE_ATTRS}${secure}`;
  };

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
    // The effective origin, so a genuine post from behind a trusted TLS proxy —
    // where the browser's Origin is `https://…` but the container sees http — is
    // not refused as foreign. Untrusted or unconfigured, this is the request's
    // own origin exactly as before, so a forged `X-Forwarded-Proto` buys
    // nothing: the guard still compares against http and turns the post away.
    if (origin !== undefined && origin !== effectiveOrigin(c, clientAddress(c), trustedProxies)) {
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
    // The device-authorization pairing endpoints are the one part of `/d/*` a
    // screen reaches *before* it holds a token — that is their whole purpose, so
    // they cannot sit behind the paired-screen gate. Same path shape the session
    // gate matches on, and un-prefixed under ingress for the same reason.
    if (c.req.path.startsWith('/d/pair/')) return next();

    // The e-paper frame carries its token in the path, not a cookie — an
    // ESPHome panel or a Home Assistant camera does a plain GET and holds no
    // session. So it authenticates itself in its own handler, the same shape as
    // `/pair`, rather than through the cookie gate here.
    if (c.req.path.startsWith('/d/epaper/')) return next();

    /*
     * The manifest is the one response rule nine cannot let a schema problem
     * take down (RFC 009, 1.9). Boot already continues past a failed or
     * partial migration and pushes a `ManifestNotice` explaining it — but
     * this middleware's own `readScreens` below is written against the
     * newest schema with no tolerance, so on a database boot could not fully
     * upgrade it throws before that notice ever reaches a wall. The manifest
     * handler does its own screen lookup, wrapped, so it can degrade to a
     * 200 carrying only notices instead.
     */
    if (c.req.path === '/d/manifest') return next();

    const screens = readScreens(deps.db);
    const screen = authenticateScreen(c, screens);
    if (!screen) {
      return c.json(
        { error: 'unauthorized', message: 'This wall is not paired.' },
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
    dismissInterrupt(deps.db, rule.source, key.slice(key.indexOf(':') + 1), now());
    return c.json({ ok: true });
  });

  /**
   * Ticking a chore off, from the wall (RFC 008 phase 3).
   *
   * The first time anything on a wall writes household data other than an
   * acknowledgement, and it is built from `/d/interrupts/dismiss` deliberately
   * — same gate, same household-wide effect, same "the server is the authority,
   * not the button".
   *
   * Three things it refuses to take from the caller, and each one is a bug it
   * would otherwise have:
   *
   * **The day.** The client sends a chore, never a date. A wall tablet's clock
   * drifts and plenty never get NTP at all, so a screen deciding which day it
   * is would tick yesterday's bins on a device an hour behind — and the whole
   * chore model hangs on the day being the household's civil date. It is
   * resolved here, once, in the household's zone, exactly as the panel that
   * drew the board resolved it.
   *
   * **Whether the chore is due.** A completion for a day the chore does not
   * fall on is a row that means nothing and shows nowhere, so it is refused
   * rather than stored — an unreadable record is worse than none.
   *
   * **Whether this screen may ask.** `allow_chores` is off by default and the
   * wall hides the control when it is, but the display token is on the wall
   * where anybody can reach it, so the check is here and the hidden control is
   * only a courtesy.
   *
   * Idempotent by the unique index on `(chore_id, date)`, which is what lets
   * the wall be careless: two screens pressed at once, or one retrying on a
   * flaky network, record one completion between them. No queue, no
   * reconciliation, no client-side state.
   */
  app.post('/d/chores/tick', async (c: Context) => {
    const screen = c.get('screen') as ScreenRow;
    if (screen.allowChores !== 1) {
      return c.json(
        { error: 'not-allowed', message: 'This wall cannot tick chores off.' },
        403,
      );
    }

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? body['id'].trim() : '';
    if (id === '' || id.length > 64) return c.json({ error: 'bad-id' }, 400);
    // Absent means done. A wall posting only an id is saying "this is done",
    // which is the overwhelmingly common press; `done=0` is the correction.
    const done = body['done'] !== '0' && body['done'] !== 'false';

    const household = readHousehold(deps.db);
    const today = localToday(household.timezone, now());
    const chore = readChores(deps.db).find((candidate) => candidate.id === id);
    if (chore === undefined) return c.json({ error: 'no-such-chore' }, 404);
    /*
     * Due today *and* not paused, which is one rule shared with the board the
     * wall drew — `activeOn`. A paused chore is on no wall, so a tick for one
     * cannot have come from a finger; it came from something holding the
     * display token, which is exactly the case this endpoint assumes.
     */
    if (!activeOn(chore, today)) {
      return c.json({ error: 'not-due', message: 'That chore is not due today.' }, 409);
    }

    setChoreDone(deps.db, chore.id, today, done, now());
    return c.json({ ok: true, date: today, done });
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
    readonly allowChores: boolean;
    readonly theme: string | null;
    readonly daytimeTheme: string | null;
    readonly daytimeStartsAt: string | null;
    readonly daytimeEndsAt: string | null;
    readonly displayTodayEvents?: number | null;
    readonly displayNextDays?: number | null;
    readonly displayHorizonWeeks?: number | null;
    readonly displayBlocks?: string | null;
    readonly clock24?: number | null;
    readonly layoutMode?: string | null;
    readonly layoutAspect?: number | null;
    readonly layoutLandscapeAspect?: number | null;
    readonly layoutBackground?: string | null;
    readonly layoutLandscapeBackground?: string | null;
  }) => {
    const at = now();
    const household = readHousehold(deps.db);
    const today = localDateOf(at, household.timezone);
    /*
     * Wider than the window, for the rota only.
     *
     * There is no narrow read left here: `buildManifest` derives the manifest
     * window itself from `daysBefore`/`daysAfter` and keys its days off that,
     * so the extra rows are invisible to the agenda and only the rota sees
     * them.
     *
     * A calendar-derived shift plan reads event *titles*, so it can only see a
     * day it has the events for — and the window holds a single day of history.
     * They exist so a run of shifts can be followed back to where it actually
     * started. Overrides go the same distance, or one sitting outside the
     * window would break a run the household had explicitly bridged.
     *
     * The read is local SQLite over an indexed date column. It costs a few
     * hundred more rows and no network.
     */
    const runFrom = shiftDate(today, -RUN_WINDOW_DAYS);
    const runTo = shiftDate(today, RUN_WINDOW_DAYS);

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

    // One list, asked twice: what each module has to say now, and which of them
    // the household has set up at all. The second is what decides whether a
    // widget with nothing behind it is drawn as a note or not drawn (RFC 009
    // Phase 2), and it has to be the same list or the two answers can disagree.
    const modules = allModules(deps.db);

    return buildManifest({
      household: effective,
      // Resolve a theme reference to its tokens (custom) or just its shape
      // (built-in). The closure over the db keeps the read out of assembly.
      resolveTheme: (ref: string) => resolveTheme(deps.db, ref),
      // Both canvases travel in the manifest; the display draws the one that
      // matches how the screen is hung, and letterboxes the other's when its own
      // orientation is empty (RFC 005).
      layoutWidgetsPortrait: readLayoutWidgets(deps.db, layoutOwner, 'portrait'),
      layoutWidgetsLandscape: readLayoutWidgets(deps.db, layoutOwner, 'landscape'),
      events: readEvents(deps.db, runFrom, runTo),
      sources: readSources(deps.db),
      people: readPeople(deps.db),
      shiftTypes: readShiftTypes(deps.db),
      shiftPlans: readShiftPlans(deps.db),
      shiftOverrides: readShiftOverrides(deps.db, runFrom, runTo),
      today,
      daysBefore: DEFAULT_DAYS_BEFORE,
      daysAfter: DEFAULT_DAYS_AFTER,
      now: at,
      appVersion: deps.appVersion,
      // Collected here rather than inside assembly, which stays pure and does
      // no I/O: every module reads its own cache, filled by its own job. The
      // registered third-party modules join the first-party ones, so they go
      // through the same isolation and ordering.
      panels: collectPanels(modules, moduleContext),
      /*
       * Which of those modules the household has set up — a location for the
       * forecast, a watched entity, an active chore. A widget with nothing
       * behind it yields its space instead of drawing a permanent note nobody
       * standing at the wall can act on (RFC 009 Phase 2).
       */
      readyModules: householdSetUp(deps.db, modules).modules,
      /*
       * Evaluated per poll, from stored signals and stored rules — every wall
       * reads the same document, including which interrupts have been cleared.
       */
      interrupts: evaluateInterrupts({
        rules: readRules(deps.db),
        // The same module list as the panels above: a third-party module's
        // signals go through the identical isolation, and core's source guard
        // keeps them matchable only by a rule the household armed for it.
        signals: collectSignals(modules, moduleContext),
        now: at,
        // Worked out here because core may not reach for `Intl` — rule one.
        localHhmm: localClock(at, timezone),
        dismissedAt: readDismissals(deps.db),
      }).active,
      screen: {
        orientation: screenLike.orientation,
        rotation: screenLike.rotation,
        allowDismiss: screenLike.allowDismiss,
        allowChores: screenLike.allowChores,
        theme: screenLike.theme,
        timezone: screenLike.timezone,
        daytimeTheme: screenLike.daytimeTheme,
        daytimeStartsAt: screenLike.daytimeStartsAt,
        daytimeEndsAt: screenLike.daytimeEndsAt,
      },
      notices: deps.bootNotices,
    });
  };

  /**
   * A paired screen's whole manifest, from its row.
   *
   * The document is already screen-specific — served behind a display token —
   * so how that screen is hung, and anything it has arranged for itself,
   * travels with it. One mapping, shared by the poll route, the layout
   * preview, and the WebSocket push server, so all three build a wall the same.
   */
  const manifestForScreen = (screen: ScreenRow): Manifest =>
    buildDisplayManifest({
      id: screen.id,
      timezone: screen.timezone,
      orientation: screen.orientation,
      rotation: screen.rotation,
      allowDismiss: screen.allowDismiss === 1,
      allowChores: screen.allowChores === 1,
      theme: screen.theme,
      daytimeTheme: screen.daytimeTheme,
      daytimeStartsAt: screen.daytimeStartsAt,
      daytimeEndsAt: screen.daytimeEndsAt,
      displayTodayEvents: screen.displayTodayEvents,
      displayNextDays: screen.displayNextDays,
      displayHorizonWeeks: screen.displayHorizonWeeks,
      displayBlocks: screen.displayBlocks,
      clock24: screen.clock24,
      layoutMode: screen.layoutMode,
      layoutAspect: screen.layoutAspect,
      layoutLandscapeAspect: screen.layoutLandscapeAspect,
      layoutBackground: screen.layoutBackground,
      layoutLandscapeBackground: screen.layoutLandscapeBackground,
    });

  // The push server, if boot wired one, builds from exactly this — see the dep.
  deps.onManifestBuilder?.(manifestForScreen);

  /**
   * The SQLite codes that mean "this file cannot be read, and waiting will not
   * change that".
   *
   * An allowlist rather than a list of exclusions, because the two answers are
   * not equally cheap. Degrading blanks a wall for that poll; a 503 costs it
   * nothing, since the display keeps drawing what it has. So an unrecognised
   * code takes the cheap answer, and a code has to be *known* persistent to
   * buy the expensive one. Written the other way round — everything degrades
   * unless it is a lock — the next transient class SQLite grows blanks every
   * wall in the house until somebody notices.
   *
   * Prefixes, because `better-sqlite3` reports SQLite's *extended* code:
   * `SQLITE_CORRUPT_VTAB` and `SQLITE_CANTOPEN_ISDIR` are real, and a WAL
   * reader whose snapshot moved raises `SQLITE_BUSY_SNAPSHOT` — measured, and
   * the reason an exact-match set was wrong here before.
   *
   * - `SQLITE_ERROR` is what a half-finished migration leaves: "no such
   *   column", "no such table". A typo in our own SQL is the same code and so
   *   degrades too; that is deliberate and it is the right side to err on,
   *   being every bit as persistent as a missing column.
   * - `SQLITE_CORRUPT` is the SD card that came out of a power cut.
   * - `SQLITE_NOTADB` is a file that never was one — a half-finished restore.
   * - `SQLITE_CANTOPEN` is the file or its directory being gone.
   *
   * Deliberately absent: `SQLITE_BUSY` and `SQLITE_LOCKED` (a CLI tool holding
   * a lock), `SQLITE_IOERR` (a disk that may well answer next time),
   * `SQLITE_PROTOCOL` (documented as retryable under WAL contention) and
   * `SQLITE_NOMEM`. All of those are a bad moment rather than a bad file.
   */
  const UNREADABLE_SQLITE_PREFIXES = [
    'SQLITE_ERROR',
    'SQLITE_CORRUPT',
    'SQLITE_NOTADB',
    'SQLITE_CANTOPEN',
  ];

  /**
   * Could the database not be read, or is this a bug in this process?
   *
   * The difference decides what a wall is told, and the two answers are not
   * interchangeable. A database that cannot be read is *persistent* and there
   * is no better data anywhere — a schema a migration left half-upgraded, an
   * SD card that came out of a power cut corrupt, a file that is no longer a
   * database at all — so the degraded manifest below, empty with a notice
   * naming the cause, is genuinely the best thing to send, and on a freshly
   * loaded wall it is the only thing standing between the household and RFC
   * 009 1.1's black screen. Anything else is a bug in this process with the
   * household's data intact, and the wall's own cached copy is worth more than
   * an empty document; a 5xx keeps it, a 200 replaces it (see the route).
   *
   * Asked of the error's `code` rather than of its message, because that is
   * the fact: `better-sqlite3` stamps every one it raises with SQLite's own
   * code and nothing else in this process carries a `SQLITE_` one — a
   * `TypeError` from our own assembly has no `code` at all, which is exactly
   * the class that must not degrade. A message match was tried first and
   * silently excluded corruption, which is the case this matters most for.
   */
  const isDatabaseFailure = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (typeof code !== 'string') return false;
    return UNREADABLE_SQLITE_PREFIXES.some((prefix) => code.startsWith(prefix));
  };

  /**
   * The manifest a wall gets when its own database could not be read.
   *
   * Built through the same pure `buildManifest` every other wall gets, with
   * safe, fixed inputs standing in for whatever could not be read — not a
   * hand-shaped partial object, so it is exactly as renderable as an empty
   * fresh install already is. `notices` is the only thing that matters here:
   * it is what lets the household read the reason instead of a black screen
   * or "not reaching the server", which is the wrong sentence for a database
   * that failed to upgrade rather than a network that is down.
   */
  const degradedManifest = (extra: ManifestNotice): Manifest =>
    buildManifest({
      household: {
        timezone: 'UTC', theme: 'board', daytimeTheme: null, daytimeStartsAt: null,
        daytimeEndsAt: null, shiftEnabled: 0, displayTodayEvents: 8, displayNextDays: 6,
        displayHorizonWeeks: 5, displayBlocks: 'now,next,horizon', clock24: 1,
        weekStart: 'sunday', layoutMode: 'auto', layoutAspect: 0.5625,
        layoutLandscapeAspect: 1.7778, layoutBackground: null, layoutLandscapeBackground: null,
      },
      events: [], sources: [], people: [], shiftTypes: [], shiftPlans: [], shiftOverrides: [],
      today: localDateOf(now(), 'UTC'),
      daysBefore: DEFAULT_DAYS_BEFORE,
      daysAfter: DEFAULT_DAYS_AFTER,
      now: now(),
      appVersion: deps.appVersion,
      notices: [...deps.bootNotices, extra],
    });

  /**
   * "Not now" — the answer for a wall whose manifest this process could not
   * build, when the household's data is fine.
   *
   * Deliberately not a manifest. The display's `failed` branch keeps the last
   * one it drew, leaves the stored copy alone, and says how old it is; that is
   * a far better wall than an empty document, and rule nine's "reduced
   * function with a clear on-screen message" is already what it produces.
   *
   * The sentence promises nothing about what is on the screen, though an
   * earlier one did — "the screen keeps showing its last one" is read out loud
   * only by a screen that has no last one, since the display draws this text
   * exactly when it has nothing else to put up. A message shown solely where
   * it is false is worse than a plainer one.
   */
  /**
   * Mark this reply as coming from *this wall's server*.
   *
   * `x-server-time` is what a display checks to tell an answer of ours from a
   * captive portal's cheerful 200, a hotel proxy's own error page, or a 401
   * from something that has never heard of this household — and that
   * difference decides whether the wall says "not reaching the server",
   * whether it advances its contact clock, whether it arms a two-hour watchdog
   * against a server it is talking to every minute, whose sentence it draws,
   * and, on a 401, whether it throws away its calendar and asks to be paired
   * again. So **every** answer `/d/manifest` gives carries it, refusals
   * included; a path that forgets is a path the wall reads as unreachable.
   *
   * The clock is read through a guard because some of those answers are the
   * last-resort ones: a `now` that throws is one of the ways a request reaches
   * them, and a safety net that can throw is not one. The display checks only
   * that the header is *there* on anything but a 200 or a 304, so a zero costs
   * nothing and stays below the `> 0` bar the client applies to the value.
   */
  const stamped = (c: Context): void => {
    let stamp = 0;
    try {
      stamp = now();
    } catch {
      // Deliberately swallowed; see above.
    }
    c.header('x-server-time', String(stamp));
  };

  const unauthorized = (c: Context): Response => {
    stamped(c);
    return c.json({ error: 'unauthorized', message: 'This wall is not paired.' }, 401);
  };

  const unavailable = (c: Context): Response => {
    stamped(c);
    return c.json(
      {
        error: 'unavailable',
        message: 'This wall could not be built just now. It will try again shortly.',
      },
      503,
    );
  };

  /**
   * The degraded manifest, and a way out if even that cannot be built.
   *
   * `degradedManifest` is the safety net, and a safety net that can throw is
   * not one: it calls `now()` and `buildManifest`, so a failure systemic enough
   * to reach either takes the fallback down with it and the household gets
   * Hono's bare JSON 500 — the exact unhandled-exception shape RFC 009 1.9 set
   * out to remove, one layer further in. Failing to "not now" instead at least
   * leaves the wall drawing what it already had.
   */
  const degraded = (c: Context, extra: ManifestNotice): Response => {
    try {
      const body = degradedManifest(extra);
      // Built before the header is set, so a fallback that throws falls to
      // `unavailable` with nothing half-written on the response.
      stamped(c);
      return c.json(body, 200);
    } catch (error) {
      console.error(
        '[manifest] degraded manifest failed too:',
        error instanceof Error ? error.message : error,
      );
      return unavailable(c);
    }
  };

  app.get('/d/manifest', (c: Context) => {
    // No credential presented at all is the ordinary shape of an unpaired
    // browser polling — refused outright, with no database read, so a
    // degraded schema never has to stand in for authentication it cannot
    // actually perform.
    const presented = presentedDisplayToken(c.req.header('authorization'), c.req.header('cookie'));
    if (presented === undefined || presented === '') {
      return unauthorized(c);
    }

    const schemaNotice: ManifestNotice = {
      level: 'error',
      code: 'schema-degraded',
      message:
        'The database could not be fully read. Calendar feed addresses may need ' +
        're-entering once this is fixed — see System for details.',
    };

    let screen: ScreenRow | undefined;
    try {
      screen = authenticateScreen(c, readScreens(deps.db));
    } catch (error) {
      console.error('[manifest] screen lookup failed:', error instanceof Error ? error.message : error);
      /*
       * The full row no longer reads, but a token was presented and still
       * has to earn a degraded manifest rather than being waved through —
       * an unrecognised bearer must get 401 whether the schema is healthy
       * or not. Falls back to the columns migration 0001 already created:
       * a database missing a *newer* addition (the realistic shape of a
       * partial upgrade) still has these, so a genuine screen's token is
       * still recognised even when the full row cannot be built.
       */
      let recognised = false;
      let undecidable = false;
      try {
        const minimal = deps.db
          .prepare(`SELECT token_hash AS tokenHash FROM screens WHERE revoked_at IS NULL`)
          .all() as { tokenHash: string }[];
        recognised = minimal.some((row) => verifyDisplayToken(presented, row.tokenHash));
      } catch (innerError) {
        console.error(
          '[manifest] minimal screen lookup also failed:',
          innerError instanceof Error ? innerError.message : innerError,
        );
        undecidable = true;
      }
      /*
       * "Not paired" is a claim, and this is the one place it cannot be made.
       *
       * A 401 is not a refusal as far as a wall is concerned — the display
       * reads it as `unpaired`, drops the manifest it is holding and draws the
       * code-entry form. So a database damaged badly enough that even this
       * one-column read throws would put a pairing form on every screen in the
       * house, which is a far louder wrong answer than a 503 and one nobody
       * standing in a kitchen can act on. When the check could not be
       * completed, say so; only a check that *ran* may say no.
       *
       * It costs a genuinely unrecognised token its 401 for as long as the
       * database is unreadable, which is the right side to be wrong on: a 503
       * discloses nothing, and neither answer serves any household data.
       */
      if (undecidable) return unavailable(c);
      if (!recognised) {
        return unauthorized(c);
      }
      /*
       * Narrowed exactly as the build's catch below is, and for the same
       * reason. A token this database still recognises has earned an answer,
       * but only a database that could not be *read* has earned the empty one:
       * this block also covers `authenticateScreen`, so anything that is a bug
       * in this process rather than a fact about the file would otherwise come
       * back as a 200 a wall draws over its own calendar. The asymmetry was
       * the accident, not the narrowing.
       */
      if (!isDatabaseFailure(error)) return unavailable(c);
      return degraded(c, schemaNotice);
    }
    if (!screen) {
      return unauthorized(c);
    }

    let manifest: Manifest;
    try {
      manifest = manifestForScreen(screen);
    } catch (error) {
      console.error('[manifest] build failed:', error instanceof Error ? error.message : error);
      /*
       * Only a database that could not be read earns the degraded manifest.
       *
       * `readScreens` reads one table, so a partial upgrade can pass the
       * lookup above and fail here — that case still degrades, or 1.9's
       * guarantee would hold on one path by accident. Anything else is a bug
       * in this process with the household's data intact, and answering 200
       * with an empty manifest is the worst of both: the display accepts it as
       * `fresh`, blanks the wall, and then `await store.save(...)` overwrites
       * the IndexedDB last-good copy, so even a reload cannot get the calendar
       * back. A 503 costs nothing — the display's `failed` branch keeps the
       * last manifest, never touches the store, and says how old it is.
       */
      if (!isDatabaseFailure(error)) return unavailable(c);
      return degraded(c, schemaNotice);
    }

    // Recorded after building, so a screen that is failing to render still
    // shows as last seen. Failing to update this would make a broken display
    // look like an absent one.
    try {
      touchScreen(deps.db, screen.id, null, c.req.header('user-agent') ?? null);
      // The wall reports its viewport so the editor can offer "match this
      // screen's size" (RFC 005). Bounds here, not in the query — a rubbish
      // string cannot write a rubbish size, and nothing depends on it to draw.
      const w = Number(c.req.query('w'));
      const h = Number(c.req.query('h'));
      const sane = (n: number): boolean => Number.isFinite(n) && n >= 120 && n <= 16384;
      if (sane(w) && sane(h)) {
        recordScreenViewport(deps.db, screen.id, Math.round(w), Math.round(h));
      }
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
   * The e-paper frame for a paired screen (RFC 006).
   *
   * A dumb device — an ESPHome panel, or a Home Assistant Generic Camera — does
   * a plain GET of `/d/epaper/<token>.png`, so the token rides in the path and
   * the screen authenticates right here rather than through the cookie gate.
   * `.png` is the finished image every consumer wants; `.bin` is the raw 1-bit
   * packing for custom firmware.
   *
   * The ETag earns its keep here more than anywhere: on a match the device gets
   * a `304` and skips the panel refresh entirely — no flash, no spent refresh
   * cycle. A render that fails degrades to `503`, never a stack trace and never
   * a blank frame the panel would happily draw as a white rectangle (rule nine).
   */
  app.get('/d/epaper/:file', (c: Context) => {
    const file = c.req.param('file');
    if (file === undefined || file === '') return c.body(null, 404);
    const dot = file.lastIndexOf('.');
    const token = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : 'png';
    if (ext !== 'png' && ext !== 'bin') return c.body(null, 404);

    const screen = readScreens(deps.db).find((candidate) =>
      verifyDisplayToken(token, candidate.tokenHash),
    );
    // 404, not 401: a guesser with no valid token learns nothing about which
    // screens exist, the same reason the media route stays behind the gate.
    if (!screen) return c.body(null, 404);

    /*
     * Whose canvas this panel draws — its own, a wall's, or none at all.
     *
     * `panelCanvasOwner` is the one place that decides, shared with the admin
     * preview so the frame on the glass and the frame on the design page cannot
     * disagree. `undefined` means the built-in fixed layout and the read is
     * skipped entirely.
     */
    const canvasOwner = panelCanvasOwner(screen);
    /*
     * The same omission the wall makes, on the same canvas (RFC 009 Phase 2).
     *
     * A panel can *follow* a wall, so an unconfigured Weather box on a Classic
     * canvas reaches this renderer too — where it draws "No weather yet", the
     * panel's spelling of the sentence the wall has stopped drawing. One stored
     * value read two ways is the fault this repository keeps paying for, so both
     * go through `keepWidgetsWithSomethingToSay`.
     *
     * Only here, on the frame a panel puts on glass. The admin's design preview
     * deliberately keeps every box: that page is where the household arranges
     * them, and a widget that vanished as it was dropped would be unusable.
     */
    const widgets =
      canvasOwner !== undefined
        ? keepWidgetsWithSomethingToSay(
            readLayoutWidgets(deps.db, canvasOwner, epaperOrientation(screen)),
            householdSetUp(deps.db),
          ).map((row) => ({
            type: row.type,
            x: row.x,
            y: row.y,
            w: row.w,
            h: row.h,
            z: row.z,
            config: row.config !== null && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {},
          }))
        : [];

    let frame: ReturnType<typeof renderScreenFrame>;
    try {
      frame = renderScreenFrame(manifestForScreen(screen), screen, widgets);
    } catch (error) {
      deps.log?.record('error', `epaper render failed for screen ${screen.id}: ${String(error)}`);
      return c.body(null, 503);
    }

    // Diagnostics only — a panel that renders must still show as last seen, and
    // a failure to record it must never fail the frame.
    try {
      touchScreen(deps.db, screen.id, null, c.req.header('user-agent') ?? null);
    } catch {
      /* not worth failing a frame over */
    }

    c.header('cache-control', 'no-cache');
    c.header('x-server-time', String(now()));
    if (c.req.header('if-none-match') === frame.etag) {
      return c.body(null, 304, { etag: frame.etag });
    }
    c.header('etag', frame.etag);
    if (ext === 'bin') {
      return c.body(bytesOf(Buffer.from(frame.fb.toPacked())), 200, {
        'content-type': 'application/octet-stream',
      });
    }
    return c.body(bytesOf(Buffer.from(encodePng1bit(frame.fb))), 200, { 'content-type': 'image/png' });
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
    deviceFlow,
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
        return manifestForScreen(screen);
      }
      return buildDisplayManifest({
        timezone: null,
        orientation: 'portrait',
        rotation: 0,
        allowDismiss: false,
        allowChores: false,
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
    c.header('set-cookie', displayCookie(token, c));
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

    c.header('set-cookie', displayCookie(issued.token, c));
    return c.json({ ok: true });
  });

  /*
   * The origin a wall screen can actually reach, for a link the app puts in a
   * QR. Identical reasoning to the admin pairing page: through ingress the
   * request origin is an internal supervisor address a tablet cannot open, so
   * the link comes from `base_url`; on the port the request origin is exactly
   * what the household reached us on and is better than a possibly-default
   * `base_url`. `device-start` is only ever hit on the port by the app, so in
   * practice this is the request origin — but the ingress branch keeps it
   * correct if it is ever reached the other way.
   */
  const reachableOrigin = (c: Context): string => {
    const base = ingressPath(c) !== '' ? deps.auth.baseUrl : new URL(c.req.url).origin;
    return base.replace(/\/+$/, '');
  };

  /*
   * Device-authorization pairing — the frictionless flow (RFC 003 Phase 3).
   *
   * A screen with no keyboard begins here, shows the short user code and a QR of
   * `verifyUrl`, and the household approves it from behind their session. See
   * `auth/device-flow.ts` for why an 8-character code is safe: approval requires
   * the login, so nobody on the LAN can approve a code they guessed.
   *
   * Open, like the rest of `/d/*`: the whole point is a fresh screen that holds
   * no credential yet. The token is never handed out here — only once the
   * household has approved, and only to the holder of the 32-byte device code.
   */
  app.post('/d/pair/device-start', (c: Context) => {
    if (deviceStartRateLimited(clientAddress(c), now())) {
      return c.json(
        { error: 'rate-limited', message: 'Too many pairing attempts. Wait a few minutes.' },
        429,
      );
    }
    const started = deviceFlow.start(now());
    // The store is full of live pending flows — vanishingly rare for a
    // household, and it clears itself as they expire. Ask the app to retry
    // rather than fail the screen; polling and manual entry are both still there.
    if (started === undefined) {
      return c.json(
        { error: 'busy', message: 'Too many walls are pairing right now. Try again shortly.' },
        503,
      );
    }
    // The household approves at the Walls page; the code is pre-filled so a
    // scanned QR lands ready to confirm. Built with the display's own short-code
    // spacing so the code on the wall and the code in the link read the same.
    const origin = reachableOrigin(c);
    const verifyUrl = `${origin}/admin/screens/approve?code=${encodeURIComponent(started.userCode)}`;
    return c.json({
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verifyUrl,
      pollIntervalSec: started.pollIntervalSec,
      expiresInSec: Math.max(0, Math.round((started.expiresAt - now()) / 1000)),
    });
  });

  /*
   * The screen's poll. Returns `pending` until the household acts, then
   * `approved` with the token exactly once (the store consumes it), or
   * `denied` / `expired`. On approval the screen hands the token to its WebView
   * via `/pair?token=…`, reusing the same cookie exchange every other pairing
   * ends with — so nothing downstream can tell a device-flow screen from a
   * QR-paired one.
   *
   * Not behind the start route's rate limit: a screen is supposed to poll
   * steadily, and the 32-byte device code is not a guessing target.
   */
  app.post('/d/pair/device-poll', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(text('A device code', 200), body['deviceCode']);
    if (!shaped.ok) {
      return c.json({ error: 'missing-device-code', message: 'No device code in the request.' }, 400);
    }
    const result = deviceFlow.poll(shaped.value, now());
    return c.json(result);
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
  /**
   * The authenticated shell's stylesheet, cached rather than inlined.
   *
   * The wizard and sign-in keep their inline `<style>`; every page past them
   * links here instead (RFC 009 Phase 6). The URL carries a content-derived
   * `?v=` so a rebuild is a new URL, which is what makes the long, immutable
   * cache safe — the ETag is a second validator for a request that lands here
   * anyway, e.g. a proxy that has stripped the query string.
   */
  app.get('/assets/admin.css', (c: Context) => {
    c.header('cache-control', 'public, max-age=31536000, immutable');
    if (c.req.header('if-none-match') === ADMIN_STYLESHEET_ETAG) {
      return c.body(null, 304, { etag: ADMIN_STYLESHEET_ETAG });
    }
    c.header('content-type', 'text/css; charset=utf-8');
    c.header('etag', ADMIN_STYLESHEET_ETAG);
    return c.body(ADMIN_STYLESHEET);
  });

  app.get('/assets/:name', (c: Context) => {
    const file = staticFiles.read(c.req.param('name') ?? '');
    if (file === undefined) return c.json({ error: 'not-found' }, 404);
    c.header('cache-control', 'no-cache');
    if (c.req.header('if-none-match') === file.etag) return c.body(null, 304, { etag: file.etag });
    c.header('content-type', file.contentType);
    c.header('etag', file.etag);
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
    c.header('cache-control', 'public, max-age=31536000, immutable');
    if (c.req.header('if-none-match') === file.etag) return c.body(null, 304, { etag: file.etag });
    c.header('content-type', file.contentType);
    c.header('etag', file.etag);
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
    c.header('cache-control', 'no-cache');
    c.header('service-worker-allowed', '/');
    if (c.req.header('if-none-match') === worker.etag) return c.body(null, 304, { etag: worker.etag });
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('etag', worker.etag);
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
      c.header('cache-control', 'no-cache');
      if (c.req.header('if-none-match') === shell.etag) return c.body(null, 304, { etag: shell.etag });
      c.header('content-type', 'text/html; charset=utf-8');
      c.header('etag', shell.etag);
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
    // The same trust decision the session gate uses (gateDeps.ingressUser),
    // one step earlier: a request the supervisor forwarded from an authenticated
    // household may skip the bootstrap code. Fails closed off the add-on.
    trustedIngress: (c: Context) =>
      isTrustedIngress(c, clientAddress(c), { isAddon: ingressTrust.isAddon, sources: trustedSources }),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  app.notFound((c: Context) => c.json({ error: 'not-found', path: c.req.path }, 404));

  app.onError((error: Error, c: Context) => {
    // Never leak internals to a display. The detail goes to the log.
    // eslint-disable-next-line no-console
    console.error('[http]', error.message);
    /*
     * Marked as ours, like every other answer. `/d/manifest` guards the screen
     * read and the build, but not `manifestEtag` or the serialisation that
     * follow — so a throw out there lands here, and an unmarked 500 is one a
     * wall reads as a stranger: no offline banner cleared, no contact clock
     * advanced, and a two-hour watchdog armed against a server it is talking to
     * every minute. Harmless on the other routes, which is why it sits here
     * rather than being threaded through the ones that can reach it.
     */
    stamped(c);
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
      textField({
        label: 'Email address',
        name: 'email',
        type: 'email',
        required: true,
        value: email,
        attrs: 'autocomplete="username"',
      }) +
      textField({
        label: 'Password',
        name: 'password',
        type: 'password',
        required: true,
        attrs: 'autocomplete="current-password"',
      }) +
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
