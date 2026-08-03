import type { Context, Hono } from 'hono';
import { issueSetupToken, setupTokenValid, shortCodeMatches, type SetupToken } from '../auth/tokens.js';
import type { SessionResolver } from '../auth/session.js';
import { addCalendarSource } from '../api/sources.js';
import { countUsers, readHousehold, readSetupState } from '../api/queries.js';
import { testFeed } from '../api/test-feed.js';
import type { Fetcher } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';
import { errorBlock, escapeHtml, page } from './html.js';
import { ingressPath } from './ingress.js';
import { checkbox, optionalText, parse, text, z } from '../validation.js';

/**
 * The wizard's three forms, as schemas.
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
import { LIFE_SAFETY_DISCLAIMER } from '../api/disclaimer.js';

/**
 * The first-run wizard.
 *
 * Three steps, of which two are required: an account, a timezone, and then a
 * calendar that can be skipped. Setup is marked complete after the timezone,
 * deliberately — a feed can fail for reasons the household does not control,
 * and a wizard that cannot be finished because Google is having a bad morning
 * would leave a wall showing nothing on the evening it was installed.
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

export function registerSetupRoutes(app: Hono, deps: SetupDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  const signedIn = async (c: Context): Promise<boolean> => {
    const user = await deps.sessions.resolve(
      new Request(c.req.url, { method: 'GET', headers: c.req.raw.headers }),
    );
    return user !== undefined;
  };

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
      if (hasSetupCookie(c, deps.setupToken, now())) return c.html(accountForm());
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
    if (!hasSetupCookie(c, deps.setupToken, now())) {
      return c.html(codeForm('That setup link has expired. Check the logs for a new code.'), 403);
    }

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(accountBody, body);
    if (!shaped.ok) {
      // The values are echoed back so nobody retypes what was already right.
      return c.html(
        accountForm(shaped.message, {
          name: typeof body['name'] === 'string' ? body['name'] : '',
          email: typeof body['email'] === 'string' ? body['email'] : '',
        }),
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
      return c.html(accountForm(message, { name, email }), 400);
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
      z.string().refine((value) => supportedTimezones().includes(value), {
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
      step: 'Step 1 of 3',
      heading: 'Enter the setup code',
      intro:
        'Maverick Wall prints a setup code to its container log when it starts. ' +
        'Find it there and enter it below. It changes every 30 minutes.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/token">` +
        `<label for="code">Setup code</label>` +
        `<input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" required>` +
        `<button type="submit">Continue</button></form>`,
    });
  }

  function accountForm(error?: string, values: { name?: string; email?: string } = {}): string {
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 1 of 3',
      heading: 'Create your account',
      intro: 'This is the only account. There is no public sign-up.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/account">` +
        `<label for="name">Your name</label>` +
        `<input id="name" name="name" type="text" required value="${escapeHtml(values.name ?? '')}">` +
        `<label for="email">Email address</label>` +
        `<input id="email" name="email" type="email" required autocomplete="username" value="${escapeHtml(values.email ?? '')}">` +
        `<label for="password">Password</label>` +
        `<input id="password" name="password" type="password" required autocomplete="new-password" minlength="10">` +
        `<label for="confirm">Password again</label>` +
        `<input id="confirm" name="confirm" type="password" required autocomplete="new-password" minlength="10">` +
        `<button type="submit">Create account</button></form>`,
    });
  }

  function timezoneForm(selected: string, error?: string): string {
    const options = supportedTimezones()
      .map(
        (zone) =>
          `<option value="${escapeHtml(zone)}"${zone === selected ? ' selected' : ''}>${escapeHtml(zone)}</option>`,
      )
      .join('');
    return page({
      title: 'Set up Maverick Wall',
      step: 'Step 2 of 3',
      heading: 'Where is this wall?',
      intro:
        'Every all-day event and the whole shift rotation are anchored to this ' +
        'zone. Getting it wrong puts birthdays on the wrong day.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="setup/household">` +
        `<label for="timezone">Timezone</label>` +
        `<select id="timezone" name="timezone" required>${options}</select>` +
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
      step: 'Step 3 of 3',
      heading: 'Add a calendar',
      intro:
        'The address of an iCal feed. In Google Calendar this is the ' +
        '"Secret address in iCal format", ending in .ics. You can skip this ' +
        'and add calendars later.',
      body:
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        `<form method="post" action="setup/calendar">` +
        `<label for="name">Name</label>` +
        `<input id="name" name="name" type="text" required placeholder="Family" value="${escapeHtml(values.name ?? '')}">` +
        `<label for="url">Address</label>` +
        `<input id="url" name="url" type="text" required placeholder="https://…/basic.ics" value="${escapeHtml(values.url ?? '')}">` +
        `<div class="checks">` +
        box('allow_lan', 'This feed is on my local network', values.allowPrivateNetwork === true) +
        box('allow_loopback', 'This feed is on this machine', values.allowLoopback === true) +
        box('allow_http', 'Allow plain http for this feed', values.allowHttp === true) +
        `</div>` +
        `<button type="submit">Test and add</button></form>` +
        `<form method="get" action="setup/done">` +
        `<button class="secondary" type="submit">Skip for now</button></form>`,
    });
  }

  function donePage(sourceCount: number): string {
    return page({
      title: 'Maverick Wall is ready',
      heading: 'That is everything',
      intro:
        sourceCount === 0
          ? 'No calendars yet. Add one with the add-source tool, or from the ' +
            'Calendars screen once it is built.'
          : 'Your calendar will sync within a few seconds.',
      body:
        `<p>Pair a display by running <span class="code">add-screen "Kitchen"</span> ` +
        `and opening the link it prints on the screen itself.</p>` +
        `<p>The admin interface is not built yet. ` +
        `<a style="color:#E0A33E" href="healthz">Check the server status</a>.</p>`,
    });
  }
}

/** True when no account exists, so boot knows whether to print a setup code. */
export function needsSetupToken(db: SqliteDatabase): boolean {
  return countUsers(db) === 0;
}
