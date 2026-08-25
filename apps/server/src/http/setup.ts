import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { issueSetupToken, setupTokenValid, shortCodeMatches, type SetupToken } from '../auth/tokens.js';
import type { SessionResolver } from '../auth/session.js';
import { addCalendarSource } from '../api/sources.js';
import {
  countUsers,
  createPerson,
  readHousehold,
  readSetupState,
  readWeatherSettings,
  writeWeatherSettings,
} from '../api/queries.js';
import { testFeed } from '../api/test-feed.js';
import type { Fetcher } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';
import { errorBlock, escapeHtml, page, selectField, textField } from './html.js';
import { ingressPath } from './ingress.js';
import { checkbox, coordinate, optionalText, parse, text, z } from '../validation.js';
import { LIFE_SAFETY_DISCLAIMER } from '../api/disclaimer.js';

/**
 * The wizard's four forms, as schemas.
 *
 * Stated here rather than checked field by field in the handlers, so that the
 * rules a household has to satisfy are readable in one place — and so the
 * handler below is about *what happens next* rather than about whether a
 * string is empty.
 */
const accountBody = z.object({
  name: text('Your name', 80),
  email: text('An email address', 200),
  // Ten, and no upper bound worth having: this is the only account, there is
  // no second factor, and the box it protects is often on a home network
  // somebody has forwarded a port to.
  password: z
    .string({ error: () => 'Choose a password.' })
    .min(10, { error: () => 'Use a password of at least 10 characters.' }),
  confirm: z.string({ error: () => 'Type the password again.' }),
}).refine((body) => body.password === body.confirm, {
  error: () => 'Those passwords do not match.',
  path: ['confirm'],
});

const calendarBody = z.object({
  name: text('A name for the calendar', 80),
  url: text('The calendar address', 2048),
  allow_lan: checkbox(),
  allow_loopback: checkbox(),
  allow_http: checkbox(),
  test: optionalText(20),
});

/**
 * Step 4 — where the wall is, and who lives there.
 *
 * Every field is optional at the schema, because the whole step is: a household
 * who has neither number to hand presses Skip and nothing here is wrong. What
 * the schema cannot say and the handler does is the cross-field rule — a
 * latitude without a longitude is half a location and would be stored as none,
 * so it is refused rather than silently dropped.
 *
 * `optionalText`, not `.optional()`: an empty text input posts `""`, and
 * `z.string().min(1).optional()` refuses that and fails the whole object — the
 * same trap that dropped every Home Assistant event with an empty `location`.
 */
const placeBody = z.object({
  latitude: optionalText(20),
  longitude: optionalText(20),
  person: optionalText(80),
});

/**
 * The colour the first person gets.
 *
 * The same value the People screen's Add form pre-fills, so somebody who adds
 * their first person here and their second there sees one product rather than
 * two, and neither is a hue nobody chose.
 */
const FIRST_PERSON_COLOR = '#4C7FD1';

/** What was typed, echoed back so a refusal costs nothing already right. */
function valuesFrom(body: Record<string, unknown>): {
  latitude: string;
  longitude: string;
  person: string;
} {
  const at = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '');
  return { latitude: at('latitude'), longitude: at('longitude'), person: at('person') };
}

/**
 * The first-run wizard.
 *
 * Four steps, of which two are required: an account, a timezone, then a
 * calendar and finally a location and a first person, both of which can be
 * skipped. Setup is marked complete after the timezone, deliberately — a feed
 * can fail for reasons the household does not control, and a wizard that cannot
 * be finished because Google is having a bad morning would leave a wall showing
 * nothing on the evening it was installed. The same argument covers step 4:
 * everything after the timezone is a wall getting better, never a wall
 * refusing to exist.
 *
 * Everything under `/setup` is exempt from both gates, so this is reachable
 * with no account and no completed setup. That means each route does its own
 * checking, and the checks are not symmetrical: creating the account needs the
 * bootstrap token, and everything after it needs a session instead, because
 * the token dies the moment an account exists.
 */

const SETUP_COOKIE = 'mw_setup';

/**
 * Scoped to the wizard, so it is not sent to any other route — and scoped to
 * where the wizard *actually is*, which is not always the root.
 *
 * Under Home Assistant ingress the browser sits at
 * `/api/hassio_ingress/<token>/setup`, and a cookie with `Path=/setup` is
 * never sent back to it. The wizard then bounces to "enter the setup code" for
 * ever: the code is right, the cookie is set, and the very next request cannot
 * carry it. The first-run screen is the one that has to work before anything
 * else does, so the path follows the prefix.
 */
function setupCookieAttrs(prefix: string): string {
  return `Path=${prefix}/setup; HttpOnly; SameSite=Lax; Max-Age=1800`;
}

export interface SetupTokenHolder {
  /** The live token, re-issued if the last one expired. */
  current(): SetupToken;
  /** Called once an account exists. */
  clear(): void;
}

/**
 * Holds the bootstrap token in memory.
 *
 * Re-issued rather than left expired, because the alternative is a household
 * who made a cup of tea coming back to a wizard they can no longer enter and
 * no way in but restarting the container.
 */
export function createSetupTokenHolder(
  onIssue: (token: SetupToken) => void,
  now: () => number = () => Date.now(),
): SetupTokenHolder {
  let token: SetupToken | undefined;
  return {
    current(): SetupToken {
      const at = now();
      if (token === undefined || at > token.expiresAt) {
        token = issueSetupToken(at);
        onIssue(token);
      }
      return token;
    },
    clear(): void {
      token = undefined;
    },
  };
}

export interface SetupDeps {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly sessions: SessionResolver;
  readonly setupToken: SetupTokenHolder;
  /**
   * Creates the first account through Better Auth.
   *
   * Takes the context rather than a ready-made request so the caller can stamp
   * the real client address on it. Without that the wizard's own sign-up is
   * attributed to nobody, and every household shares one rate-limit bucket —
   * which showed up here as the fourth test in a file failing to create an
   * account at all.
   */
  readonly signUp: (
    c: Context,
    input: { name: string; email: string; password: string },
  ) => Promise<Response>;
  /**
   * True when this request reached the wizard through a trusted Home Assistant
   * ingress — the supervisor forwarding a household already signed in, pinned to
   * its socket source rather than the forgeable header. When it is, the bootstrap
   * code is redundant: getting here is itself proof of owning the box, the same
   * argument the post-setup gate already makes. Absent (plain `docker run`, and
   * every test that does not set it) means "not trusted", so the code still
   * stands. Built by `app.ts` from the same `isTrustedIngress` the session gate
   * uses; never re-derived here.
   */
  readonly trustedIngress?: (c: Context) => boolean;
  readonly now?: () => number;
}

function hasSetupCookie(c: Context, holder: SetupTokenHolder, now: number): boolean {
  const header = c.req.header('cookie');
  if (!header) return false;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SETUP_COOKIE) return setupTokenValid(holder.current(), rest.join('='), now);
  }
  return false;
}

/**
 * The zones offered in the timezone step.
 *
 * Straight from the runtime rather than a bundled list, so it cannot go stale
 * relative to the `Intl` data that every all-day event and the whole shift
 * rotation are anchored against.
 */
function supportedTimezones(): string[] {
  const values = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof values === 'function') return values('timeZone');
  // Older runtimes. Better a short list than an empty select.
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Europe/London', 'Europe/Dublin', 'Europe/Paris',
    'Europe/Berlin', 'Australia/Sydney'];
}

function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The fallback offered on the form, and the one value that is always accepted.
 *
 * `Intl.supportedValuesOf('timeZone')` carries neither `'UTC'` nor `'Etc/UTC'`
 * on the ICU data this project has seen — so a container with no `TZ` set (as
 * `docker run` leaves it) detects `'UTC'` and finds it nowhere in the list. A
 * zone the platform genuinely resolves has to be offered rather than silently
 * dropped.
 */
const UTC_FALLBACK = 'Etc/UTC';

/**
 * The zones offered, always including a zone the platform always accepts.
 *
 * Exported so the admin's own timezone forms (household default, per-screen
 * override) read the identical list — a zone the wizard can store but the
 * admin's own dropdown cannot offer would render exactly this bug again the
 * first time a household reopened Settings.
 */
export function offeredTimezones(): string[] {
  const zones = supportedTimezones();
  return zones.includes(UTC_FALLBACK) ? zones : [...zones, UTC_FALLBACK];
}

/**
 * Canonicalise before comparing against the offered list.
 *
 * `Intl` resolves aliases (`Asia/Calcutta` → `Asia/Kolkata`) to the name
 * `supportedValuesOf` actually returns, so a detected alias still matches an
 * offered option instead of falling through to the UTC fallback for no reason.
 */
function normaliseTimezone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/**
 * Which offered zone a detected zone should preselect.
 *
 * Never "nothing" — an unmatched detection is treated as a bug rather than a
 * default, so it falls back to a zone that is always in the offered list
 * rather than leaving the `<select>` to preselect whatever sorts first.
 */
function detectedTimezoneOption(zones: string[], detected: string): string {
  const canonical = normaliseTimezone(detected);
  if (zones.includes(canonical)) return canonical;
  if (zones.includes(detected)) return detected;
  return UTC_FALLBACK;
}

export function registerSetupRoutes(app: Hono, deps: SetupDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  const signedIn = async (c: Context): Promise<boolean> => {
    const user = await deps.sessions.resolve(
      new Request(c.req.url, { method: 'GET', headers: c.req.raw.headers }),
    );
    return user !== undefined;
  };

  /**
   * Did this request reach the wizard through a trusted supervisor source? If so
   * the bootstrap code is redundant. Fails closed to `false` when no predicate
   * was wired (plain `docker run` and every test that leaves it unset).
   */
  const trusted = (c: Context): boolean => deps.trustedIngress?.(c) === true;

  // -------------------------------------------------------------------------
  // Entry
  // -------------------------------------------------------------------------

  app.get('/setup', async (c: Context) => {
    const state = readSetupState(deps.db);

    if (state.complete) return c.redirect('/setup/done', 302);

    if (!state.hasUsers) {
      /*
       * A token in the URL is exchanged for a cookie and then removed by the
       * redirect, the same trade `/pair` makes: the credential appears once
       * and never again in a history entry somebody later screenshots.
       */
      const fromUrl = c.req.query('token');
      if (fromUrl !== undefined && setupTokenValid(deps.setupToken.current(), fromUrl, now())) {
        c.header('set-cookie', `${SETUP_COOKIE}=${fromUrl}; ${setupCookieAttrs(ingressPath(c))}`);
        return c.redirect('/setup', 302);
      }
      // A valid code (the cookie) or a trusted supervisor source both prove the
      // household owns the box; either goes straight to creating the account.
      const viaIngress = trusted(c);
      if (hasSetupCookie(c, deps.setupToken, now()) || viaIngress) {
        return c.html(accountForm(undefined, {}, viaIngress));
      }
      return c.html(codeForm(fromUrl !== undefined ? 'That link has expired.' : undefined));
    }

    // An account exists, so the bootstrap token is spent and this is the
    // household's own session or nothing.
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);
    return c.html(timezoneForm(serverTimezone()));
  });

  // -------------------------------------------------------------------------
  // Step 1 — the account
  // -------------------------------------------------------------------------

  /** Short code entry, for somebody reading the log on a phone. */
  app.post('/setup/token', async (c: Context) => {
    if (readSetupState(deps.db).hasUsers) return c.redirect('/setup', 302);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    /*
     * The bootstrap code, which is the only way into a fresh installation.
     *
     * Shaped like everything else, and compared with `shortCodeMatches` rather
     * than by the schema: the comparison has to be constant-time, and a Zod
     * refinement that short-circuits on the first wrong character would leak
     * the code one character at a time to anybody who can reach the port.
     */
    const shapedCode = parse(text('The setup code', 64), body['code']);
    const presented = shapedCode.ok ? shapedCode.value : '';
    const token = deps.setupToken.current();

    if (!shortCodeMatches(token.token, presented)) {
      return c.html(codeForm('That code is not right, or it has expired.'), 400);
    }
    c.header('set-cookie', `${SETUP_COOKIE}=${token.token}; ${setupCookieAttrs(ingressPath(c))}`);
    return c.redirect('/setup', 302);
  });

  app.post('/setup/account', async (c: Context) => {
    const state = readSetupState(deps.db);
    if (state.complete) return c.redirect('/setup/done', 302);
    // Both, not either. The token alone must not create a second account, and
    // an account must not be creatable without it.
    if (state.hasUsers) return c.html(codeForm('An account already exists.'), 403);
    // The bootstrap code (the cookie) or a trusted supervisor source. On the
    // add-on the supervisor forwarding an authenticated household is proof
    // enough; off it, only the code is, and this fails closed to demanding it.
    const viaIngress = trusted(c);
    if (!hasSetupCookie(c, deps.setupToken, now()) && !viaIngress) {
      return c.html(codeForm('That setup link has expired. Check the logs for a new code.'), 403);
    }

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(accountBody, body);
    if (!shaped.ok) {
      // The values are echoed back so nobody retypes what was already right.
      return c.html(
        accountForm(
          shaped.message,
          {
            name: typeof body['name'] === 'string' ? body['name'] : '',
            email: typeof body['email'] === 'string' ? body['email'] : '',
          },
          viaIngress,
        ),
        400,
      );
    }
    // Length and confirmation are both in `accountBody`; there is nothing left
    // to check here that the schema has not already refused.
    const { name, email, password } = shaped.value;

    const created = await deps.signUp(c, { name, email, password });

    if (created.status >= 400) {
      // Better Auth's own reason, which knows about things this does not —
      // a malformed address, a password on a breach list.
      let message = 'That account could not be created.';
      try {
        const problem = (await created.json()) as { message?: string };
        if (typeof problem.message === 'string' && problem.message !== '') message = problem.message;
      } catch {
        // Keep the generic message.
      }
      return c.html(accountForm(message, { name, email }, viaIngress), 400);
    }

    // Spent. Nothing consults it again, but holding a live credential in
    // memory for the life of the process would be careless.
    deps.setupToken.clear();

    // Carried over verbatim: this is the session cookie the household is now
    // signed in with, and dropping it would send them straight to a sign-in
    // form seconds after choosing a password.
    for (const cookie of created.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true });
    }
    return c.redirect('/setup', 302);
  });

  // -------------------------------------------------------------------------
  // Step 2 — the timezone. Completing this completes setup.
  // -------------------------------------------------------------------------

  app.post('/setup/household', async (c: Context) => {
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    /*
     * Membership, not a pattern.
     *
     * A zone `Intl` does not know is one the recurrence code cannot anchor
     * against, and it would fail later at the point where it is hardest to
     * connect back to this form.
     */
    const shapedZone = parse(
      z.string().refine((value) => offeredTimezones().includes(value), {
        error: () => 'Choose a timezone from the list.',
      }),
      body['timezone'],
    );
    if (!shapedZone.ok) {
      return c.html(timezoneForm(serverTimezone(), shapedZone.message), 400);
    }
    const timezone = shapedZone.value;

    const at = now();
    deps.db
      .prepare(
        `UPDATE household_settings
            SET timezone = ?, setup_completed_at = ?, updated_at = ?
          WHERE id = 'singleton'`,
      )
      .run(timezone, at, at);

    return c.redirect('/setup/calendar', 302);
  });

  // -------------------------------------------------------------------------
  // Step 3 — a calendar. Optional, and setup is already complete by here.
  // -------------------------------------------------------------------------

  app.get('/setup/calendar', async (c: Context) => {
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);
    return c.html(calendarForm());
  });

  app.post('/setup/calendar', async (c: Context) => {
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shapedFeed = parse(calendarBody, body);
    if (!shapedFeed.ok) {
      // Echoed back, so a bad address does not also cost the name above it.
      return c.html(
        calendarForm(
          {
            name: typeof body['name'] === 'string' ? body['name'] : '',
            url: typeof body['url'] === 'string' ? body['url'] : '',
            allowPrivateNetwork: typeof body['allow_lan'] === 'string',
            allowLoopback: typeof body['allow_loopback'] === 'string',
            allowHttp: typeof body['allow_http'] === 'string',
          },
          { message: shapedFeed.message },
        ),
        400,
      );
    }

    const name = shapedFeed.value.name;
    const url = shapedFeed.value.url;
    const allowPrivateNetwork = shapedFeed.value.allow_lan;
    const allowLoopback = shapedFeed.value.allow_loopback;
    const allowHttp = shapedFeed.value.allow_http;
    const values = { name, url, allowPrivateNetwork, allowLoopback, allowHttp };

    /*
     * Fetched and parsed before it is stored.
     *
     * A source row that exists but has never worked is the worst outcome
     * here: the wizard says it succeeded, and the failure surfaces hours
     * later as an empty calendar with nothing pointing back at this form.
     */
    const tested = await testFeed(
      {
        url,
        allowPrivateNetwork,
        allowLoopback,
        allowHttp,
        // The zone chosen a step ago. Expanding a feed against the wrong one
        // would report the wrong dates back in the preview.
        timezone: readHousehold(deps.db).timezone,
      },
      deps.fetcher,
    );
    if (!tested.ok) {
      return c.html(
        calendarForm(values, {
          message: tested.message,
          ...(tested.suggestion !== undefined ? { suggestion: tested.suggestion } : {}),
        }),
        400,
      );
    }

    const added = addCalendarSource(deps.db, deps.keyring, {
      name,
      url,
      allowPrivateNetwork,
      allowLoopback,
      allowHttp,
    });
    if (!added.ok) {
      return c.html(calendarForm(values, { message: added.message }), 400);
    }

    return c.redirect('/setup/place', 302);
  });

  // -------------------------------------------------------------------------
  // Step 4 — where the wall is and who lives there. Optional, like step 3.
  // -------------------------------------------------------------------------

  /*
   * Two prerequisites for two widgets the default wall already contains, asked
   * for once at the only moment every household passes through (RFC 009 Phase
   * 2). Before this the product shipped a Weather box and a Shift box with
   * nothing behind either, and nothing anywhere asked.
   *
   * Skipping is a real answer and costs nothing: the wall omits both boxes
   * rather than drawing "Nothing to show yet." where a widget will never have
   * anything to say, and no weather rule is armed until a location exists.
   */

  app.get('/setup/place', async (c: Context) => {
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);
    return c.html(placeForm());
  });

  app.post('/setup/place', async (c: Context) => {
    if (!(await signedIn(c))) return c.redirect('/admin/sign-in', 302);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(placeBody, body);
    if (!shaped.ok) return c.html(placeForm(valuesFrom(body), shaped.message), 400);

    const { latitude, longitude, person } = shaped.value;
    const values = { latitude: latitude ?? '', longitude: longitude ?? '', person: person ?? '' };
    const wantsLocation = values.latitude !== '' || values.longitude !== '';

    if (wantsLocation) {
      /*
       * All or nothing, and said rather than silently dropped.
       *
       * Half a location stores as none — the weather module needs both — so a
       * household who typed one number and moved on would come back to a wall
       * with no forecast and a form that looks filled in. The Weather screen
       * refuses the same pair for the same reason.
       */
      const lat = parse(coordinate('Latitude', 90), values.latitude);
      const lon = parse(coordinate('Longitude', 180), values.longitude);
      if (!lat.ok || !lon.ok) {
        /*
         * A box left empty is a different mistake from a box filled in wrongly,
         * and only the second has a reason worth printing. "Longitude has to be
         * a number" is a confusing thing to read about a field you never
         * touched — the household typed one number and did not know the other
         * was needed, which is what the pair sentence says.
         */
        let message =
          'A location is both numbers — latitude between -90 and 90, longitude between -180 and 180.';
        if (values.latitude !== '' && values.longitude !== '') {
          if (!lat.ok) message = lat.message;
          else if (!lon.ok) message = lon.message;
        }
        return c.html(placeForm(values, message), 400);
      }
      const current = readWeatherSettings(deps.db);
      writeWeatherSettings(deps.db, {
        // Whatever the switch already says. It ships on, and this step is about
        // telling it where to look rather than about turning it on.
        enabled: current.enabled,
        latitude: lat.value,
        longitude: lon.value,
        provider: current.provider,
        units: current.units,
      });
    }

    if (values.person !== '') {
      /*
       * One person, with the colour the People screen offers first.
       *
       * No colour picker here: a wizard is not the place to choose a hue, the
       * People screen is, and a default that can be changed in one click beats
       * a fourth field on the last step somebody wants to be finished with.
       */
      createPerson(deps.db, randomBytes(8).toString('hex'), values.person, FIRST_PERSON_COLOR);
    }

    return c.redirect('/setup/done', 302);
  });

  app.get('/setup/done', (c: Context) => {
    const state = readSetupState(deps.db);
    if (!state.complete) return c.redirect('/setup', 302);
    const sources = deps.db.prepare('SELECT COUNT(*) AS total FROM calendar_sources').get() as {
      total: number;
    };
    return c.html(donePage(sources.total));
  });

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  function codeForm(error?: string): string {
    // Deliberately does not print the code. Anyone who can load this page can
    // read it, and the point of the code is that reaching the log proves you
    // are the person running the container.
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 1 of 4',
      heading: 'Enter the setup code',
      intro:
        'Maverick Wall prints a setup code to its container log when it starts. ' +
        'Find it there and enter it below. It changes every 30 minutes.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/token">` +
        textField({
          label: 'Setup code',
          name: 'code',
          required: true,
          attrs: 'autocomplete="off" autocapitalize="characters"',
        }) +
        `<button type="submit">Continue</button></form>`,
    });
  }

  function accountForm(
    error?: string,
    values: { name?: string; email?: string } = {},
    viaIngress = false,
  ): string {
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 1 of 4',
      heading: 'Create your account',
      intro: 'This is the only account. There is no public sign-up.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        // Reached through Home Assistant: the supervisor already vouched for the
        // household, so there was no code to find in the log.
        (viaIngress
          ? `<p class="hint">You reached this through Home Assistant, so there’s no ` +
            `setup code to find — just create your account.</p>`
          : '') +
        `<form method="post" action="setup/account">` +
        textField({ label: 'Your name', name: 'name', required: true, value: values.name ?? '' }) +
        textField({
          label: 'Email address',
          name: 'email',
          type: 'email',
          required: true,
          value: values.email ?? '',
          attrs: 'autocomplete="username"',
        }) +
        textField({
          label: 'Password',
          name: 'password',
          type: 'password',
          required: true,
          hint: 'At least 10 characters.',
          attrs: 'autocomplete="new-password" minlength="10"',
        }) +
        textField({
          label: 'Password again',
          name: 'confirm',
          type: 'password',
          required: true,
          attrs: 'autocomplete="new-password" minlength="10"',
        }) +
        `<button type="submit">Create account</button></form>`,
    });
  }

  function timezoneForm(detected: string, error?: string): string {
    const zones = offeredTimezones();
    const effective = detectedTimezoneOption(zones, detected);
    const options = zones
      .map(
        (zone) =>
          `<option value="${escapeHtml(zone)}"${zone === effective ? ' selected' : ''}>${escapeHtml(zone)}</option>`,
      )
      .join('');
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 2 of 4',
      heading: 'Where is this wall?',
      intro:
        'Every all-day event and the whole shift rotation are anchored to this ' +
        'zone. Getting it wrong puts birthdays on the wrong day.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/household">` +
        selectField({
          label: 'Timezone',
          name: 'timezone',
          optionsHtml: options,
          attrs: 'required',
          // A preselected value with no explanation is a value nobody checks.
          hint: `Detected: ${detected}. Change it if this wall is somewhere else.`,
        }) +
        `<button type="submit">Save and continue</button></form>` +

        /*
         * The disclaimer, in the wizard.
         *
         * Here rather than on a settings screen nobody visits, because this is
         * the one moment every household passes through. Weather alerts are on
         * by default in the United States, so somebody who never opens the
         * alerts screen would otherwise have a wall that shows tornado
         * warnings and never be told what it does not promise.
         */
        `<div class="error" style="margin-top:2rem">` +
        `<strong>About weather alerts</strong>` +
        `<span>${escapeHtml(LIFE_SAFETY_DISCLAIMER)}</span></div>` +
        `<p class="hint">National Weather Service alerts are shown in the United ` +
        `States. You can change what each level does, or switch them off, on the ` +
        `Weather alerts screen.</p>`,
    });
  }

  function calendarForm(
    values: {
      name?: string;
      url?: string;
      allowPrivateNetwork?: boolean;
      allowLoopback?: boolean;
      allowHttp?: boolean;
    } = {},
    error?: { message: string; suggestion?: string },
  ): string {
    const box = (id: string, label: string, on: boolean): string =>
      `<label><input type="checkbox" name="${id}" value="1"${on ? ' checked' : ''}> ${escapeHtml(label)}</label>`;
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 3 of 4',
      heading: 'Add a calendar',
      intro:
        'The address of an iCal feed. In Google Calendar this is the ' +
        '"Secret address in iCal format", ending in .ics. You can skip this ' +
        'and add calendars later.',
      body:
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        `<form method="post" action="setup/calendar">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Family',
          value: values.name ?? '',
        }) +
        textField({
          label: 'Address',
          name: 'url',
          required: true,
          placeholder: 'https://…/basic.ics',
          value: values.url ?? '',
        }) +
        `<div class="checks">` +
        box('allow_lan', 'This feed is on my local network', values.allowPrivateNetwork === true) +
        box('allow_loopback', 'This feed is on this machine', values.allowLoopback === true) +
        box('allow_http', 'Allow plain http for this feed', values.allowHttp === true) +
        `</div>` +
        `<button type="submit">Test and add</button></form>` +
        `<form method="get" action="setup/place">` +
        // A text button: skipping is the lowest-emphasis choice on the page.
        `<button class="btn-text" type="submit">Skip for now</button></form>`,
    });
  }

  /**
   * Step 4: where the wall is, and who lives there.
   *
   * Two questions on one screen because they are the same question from the
   * wall's point of view — the two widgets the default canvas already draws and
   * has never had anything to put in. Both may be left empty.
   *
   * A latitude and a longitude typed by hand is not a nice ask, and it is the
   * same ask the Weather screen makes for the same reason: there is no
   * geocoder, because a place name would have to be sent to somebody, and rule
   * three is about the wall but the instinct is about the household. The hint
   * names the way everybody actually gets the numbers.
   */
  function placeForm(
    values: { latitude?: string; longitude?: string; person?: string } = {},
    error?: string,
  ): string {
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 4 of 4',
      heading: 'Your location, and who lives here',
      /*
       * The forecast and the person are not the same promise, and saying they
       * are would be a wizard that lies about its own next screen. Two numbers
       * genuinely turn the forecast strip on. A name does not turn the rota
       * badge on — that waits on a rotation, which is a job for the Shifts
       * screen and too much to ask on the last step of a first run.
       */
      intro:
        'Two numbers put a forecast on the wall. A name is somebody for the wall ' +
        'to know about. Both can be skipped and added later.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/place">` +
        `<div class="row-fields">` +
        textField({
          label: 'Latitude',
          name: 'latitude',
          placeholder: '38.8894',
          value: values.latitude ?? '',
          attrs: 'inputmode="decimal"',
        }) +
        textField({
          label: 'Longitude',
          name: 'longitude',
          placeholder: '-97.7431',
          value: values.longitude ?? '',
          attrs: 'inputmode="decimal"',
        }) +
        `</div>` +
        `<p class="hint">Press and hold your house in a phone map app and both ` +
        `numbers are there. They are used for the forecast strip and, in the ` +
        `United States, to work out which National Weather Service zones to ` +
        `watch. No alert rule is armed until there is a zone being watched.</p>` +
        textField({
          label: 'Who lives here?',
          name: 'person',
          placeholder: 'Sam',
          value: values.person ?? '',
          hint:
            'Their colour marks their events once a calendar is assigned to ' +
            'them on Calendars. A shift rotation is separate again, on Shifts ' +
            '— a name on its own starts neither.',
        }) +
        `<button type="submit">Save and finish</button></form>` +
        `<form method="get" action="setup/done">` +
        `<button class="btn-text" type="submit">Skip for now</button></form>`,
    });
  }

  function donePage(sourceCount: number): string {
    return page({
      title: 'Maverick Wall is ready',
      heading: 'That is everything',
      intro:
        sourceCount === 0
          ? 'No calendars yet — you can add one from the Calendars screen whenever you like.'
          : 'Your calendar will sync within a few seconds.',
      body:
        `<p>Pair a wall display from the <a class="link" href="admin/displays">Displays</a> ` +
        `screen — it gives you a QR code and a link to open on the screen itself.</p>` +
        `<p><a class="link" href="admin">Go to the admin →</a></p>`,
    });
  }
}

/** True when no account exists, so boot knows whether to print a setup code. */
export function needsSetupToken(db: SqliteDatabase): boolean {
  return countUsers(db) === 0;
}
