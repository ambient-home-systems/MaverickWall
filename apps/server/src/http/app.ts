import { Hono, type Context, type Next } from 'hono';
import { localDateOf } from '@maverick-wall/calendar';
import { verifyDisplayToken } from '../auth/tokens.js';
import { buildManifest, manifestEtag, type ManifestNotice } from '../api/manifest.js';
import {
  countUsers,
  readEvents,
  readHousehold,
  readLastSync,
  readSchemaVersion,
  readScreens,
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

export interface AppDeps {
  readonly db: SqliteDatabase;
  readonly appVersion: string;
  /** Notices from boot — a failed migration, a permissions warning. */
  readonly bootNotices: readonly ManifestNotice[];
  readonly now?: () => number;
}

const DISPLAY_COOKIE = 'mw_display';

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

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());

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

  app.get('/d/manifest', (c: Context) => {
    const screen = c.get('screen') as ScreenRow;
    const at = now();
    const household = readHousehold(deps.db);
    const today = localDateOf(at, household.timezone);

    const from = shiftDate(today, -DEFAULT_DAYS_BEFORE);
    const to = shiftDate(today, DEFAULT_DAYS_AFTER);

    const manifest = buildManifest({
      household,
      events: readEvents(deps.db, from, to),
      sources: readSources(deps.db),
      shiftTypes: readShiftTypes(deps.db),
      shiftPlans: readShiftPlans(deps.db),
      shiftOverrides: readShiftOverrides(deps.db, from, to),
      today,
      daysBefore: DEFAULT_DAYS_BEFORE,
      daysAfter: DEFAULT_DAYS_AFTER,
      now: at,
      appVersion: deps.appVersion,
      notices: deps.bootNotices,
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
    c.header('x-server-time', String(at));
    c.header('cache-control', 'no-cache');

    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { etag });
    }

    c.header('etag', etag);
    return c.json(manifest);
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
    c.header(
      'set-cookie',
      `${DISPLAY_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000`,
    );
    return c.redirect('/', 302);
  });

  app.get('/', (c: Context) => {
    // The display bundle lands here. Until it exists, say something useful
    // rather than 404 — a blank screen is the one outcome to avoid.
    const users = countUsers(deps.db);
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Maverick Wall</title>` +
        `<body style="font:16px system-ui;padding:2rem;background:#0B0E11;color:#E9EEF4">` +
        `<h1>Maverick Wall</h1>` +
        `<p>The server is running. The display bundle is not built yet.</p>` +
        `<p>${users === 0 ? 'No account has been created. Check the container logs for the setup link.' : 'Try <code>/healthz</code> or <code>/d/manifest</code>.'}</p>`,
    );
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

/** Civil date arithmetic without pulling core in for one call. */
function shiftDate(date: string, days: number): string {
  const parts = date.split('-').map(Number);
  const ms = Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1) + days * 86_400_000;
  const shifted = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
