import { createHash, randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';

import { readAdminSources, readPeopleAdmin, type AdminSourceRow } from '../api/queries.js';
import { dropPendingOAuth, holdPendingOAuth, readPendingOAuth, type PendingOAuth } from '../api/oauth-pending.js';
import {
  accessToken,
  addOAuthCalendar,
  createOAuthAccount,
  readOAuthAccounts,
  removeOAuthAccount,
  replaceOAuthTokens,
  type OAuthAccountRow,
} from '../oauth/accounts.js';
import { listGoogleCalendars, listMicrosoftCalendars } from '../oauth/calendars.js';
import { OAUTH, providerName, type OAuthEndpoints, type OAuthProvider } from '../oauth/endpoints.js';
import {
  MICROSOFT_TENANT,
  exchangeGoogleCode,
  googleConsentUrl,
  pollMicrosoftDeviceCode,
  startMicrosoftDeviceCode,
} from '../oauth/token.js';
import { optionalText, parse, z } from '../validation.js';
import { confirmDestroyPage, errorBlock, escapeHtml, noticeBlock, page, selectField, switchRow, textField } from './html.js';
import { card, destructive, emptyState, listRow, section, tag } from './components.js';
import { savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * Signing in to Google Calendar and Microsoft 365, in the admin (plan item
 * M5.11).
 *
 * **With the household's own app, never ours.** A shared app would put every
 * household's calendar access behind one client this project would have to
 * keep verified with Google and registered with Microsoft, and one revocation
 * would take every wall's calendars off at once. So each household registers
 * their own — a Google Cloud OAuth client, an Entra app registration — and the
 * pages here walk through it, which is the price of nothing in between.
 *
 * **Two flows, because the providers allow different ones.** Microsoft offers
 * the device-code flow for calendars: a code the household types at
 * microsoft.com/devicelogin on any device, which works on an install with no
 * public address at all. Google's device flow does not offer the Calendar
 * scope, so Google is the ordinary browser redirect — and Google only sends a
 * sign-in back to a public https address. An install without one is told so,
 * and pointed at the routes that do work there, rather than shown a form that
 * fails at Google's end with a message about redirect URIs.
 *
 * Nothing secret crosses a page: the client secret, the device code, the PKCE
 * verifier and the refresh token are held in `oauth-pending.ts` under an id
 * until the household picks calendars, and sealed when the account is stored.
 */

const GOOGLE_CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{16}$/;
const PENDING_ID = /^[0-9a-f]{64}$/;

const googleStartBody = z.object({
  client_id: z
    .string()
    .trim()
    .regex(GOOGLE_CLIENT_ID, 'That is not a Google client ID — it ends in .apps.googleusercontent.com.'),
  client_secret: z
    .string()
    .trim()
    .min(1, 'Paste the client secret as well.')
    .max(200, 'That is longer than a Google client secret.')
    .regex(/^\S+$/, 'A client secret has no spaces in it.'),
});
const microsoftStartBody = z.object({
  client_id: z.string().trim().regex(GUID, 'That is not a client ID — it looks like 1a2b3c4d-…, five groups of letters and digits.'),
  tenant: z
    .string()
    .trim()
    .transform((value) => (value === '' ? 'common' : value))
    .pipe(z.string().regex(MICROSOFT_TENANT, 'That is not a directory Microsoft knows by that name.')),
});
const accountBody = z.object({ account: z.string().regex(ACCOUNT_ID, 'That account is not here any more.') });
const pendingBody = z.object({ pending: z.string().regex(PENDING_ID, 'That sign-in is not here any more.') });
const pickBody = pendingBody.extend({ person_id: optionalText(40) });

/**
 * The address Google sends a sign-in back to, or nothing when this install
 * has no address Google will send one to.
 *
 * Google refuses a redirect URI that is not https on a public domain: no IP
 * address, no `localhost`, no `.local`. So the test is that, written down,
 * before a household spends ten minutes in Google Cloud registering an address
 * Google will then refuse to use.
 */
export function googleRedirectUri(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || !host.includes('.')) return undefined;
  if (/\.(local|lan|home|internal|localhost|localdomain|home\.arpa)$/.test(host)) return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}/admin/calendars/google/callback`;
}

/** PKCE: the verifier this process keeps, and the challenge Google is shown. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface MicrosoftEcho {
  readonly clientId?: string;
  readonly tenant?: string;
}

export function registerOAuthRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  const endpoints: OAuthEndpoints = deps.oauth ?? OAUTH;
  const context = (): { db: typeof deps.db; keyring: typeof deps.keyring; fetcher: typeof deps.fetcher; now: number } => ({
    db: deps.db,
    keyring: deps.keyring,
    fetcher: deps.fetcher,
    now: now(),
  });
  const account = (id: string): OAuthAccountRow | undefined =>
    readOAuthAccounts(deps.db).find((candidate) => candidate.id === id);

  /* ---- Microsoft 365: the device code --------------------------------- */

  app.get('/admin/calendars/new/microsoft', (c: Context) => c.html(microsoftPage(c, {})));

  app.post('/admin/calendars/microsoft/start', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    // Signing an existing account in again takes its app from the account,
    // so a household is never asked to find the client ID twice.
    const again = parse(accountBody, body);
    let clientId: string;
    let tenant: string;
    let reauth: string | undefined;
    if (again.ok) {
      const stored = account(again.value.account);
      if (stored === undefined || stored.provider !== 'microsoft') return c.redirect('/admin/calendars', 302);
      clientId = stored.clientId;
      tenant = stored.tenant ?? 'common';
      reauth = stored.id;
    } else {
      const echo: MicrosoftEcho = {
        clientId: typeof body['client_id'] === 'string' ? body['client_id'].slice(0, 80) : '',
        tenant: typeof body['tenant'] === 'string' ? body['tenant'].slice(0, 120) : '',
      };
      const shaped = parse(microsoftStartBody, body);
      if (!shaped.ok) return c.html(microsoftPage(c, echo, shaped.message), 400);
      clientId = shaped.value.client_id;
      tenant = shaped.value.tenant;
    }
    const started = await startMicrosoftDeviceCode(deps.fetcher, endpoints, { clientId, tenant });
    if (!started.ok) return c.html(microsoftPage(c, { clientId, tenant }, started.message), 400);
    const at = now();
    const id = holdPendingOAuth(
      {
        step: 'microsoft-code',
        clientId,
        tenant,
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: at + started.expiresInSec * 1000,
        ...(reauth === undefined ? {} : { reauth }),
      },
      at,
    );
    return c.html(microsoftCodePage(c, id, started.userCode, started.verificationUri));
  });

  app.post('/admin/calendars/microsoft/poll', async (c: Context) => {
    const shaped = parse(pendingBody, (await c.req.parseBody()) as Record<string, unknown>);
    const held = shaped.ok ? readPendingOAuth(shaped.value.pending, now()) : undefined;
    if (!shaped.ok || held === undefined || held.step !== 'microsoft-code') {
      return c.html(microsoftPage(c, {}, 'That sign-in took too long and was forgotten. Start it again.'), 400);
    }
    const id = shaped.value.pending;
    if (held.expiresAt <= now()) {
      dropPendingOAuth(id);
      return c.html(microsoftPage(c, held, 'The code expired before the sign-in finished. Start it again.'), 400);
    }
    const polled = await pollMicrosoftDeviceCode(deps.fetcher, endpoints, {
      clientId: held.clientId,
      tenant: held.tenant,
      deviceCode: held.deviceCode,
    });
    switch (polled.state) {
      case 'pending':
      case 'slow-down':
        return c.html(
          microsoftCodePage(
            c,
            id,
            held.userCode,
            held.verificationUri,
            'Microsoft has not seen the sign-in finish yet. Enter the code there, accept, then press the button again.',
          ),
        );
      case 'declined':
        dropPendingOAuth(id);
        return c.html(microsoftPage(c, held, 'The sign-in was declined at Microsoft, so nothing was added.'), 400);
      case 'expired':
        dropPendingOAuth(id);
        return c.html(microsoftPage(c, held, 'The code expired before the sign-in finished. Start it again.'), 400);
      case 'failed':
        dropPendingOAuth(id);
        return c.html(microsoftPage(c, held, polled.message), 400);
      case 'ok':
        break;
    }
    dropPendingOAuth(id);
    const refreshToken = polled.refreshToken ?? '';
    if (held.reauth !== undefined) {
      return replaceOAuthTokens(deps.db, deps.keyring, held.reauth, refreshToken, polled.label, now())
        ? savedRedirect(c, '/admin/calendars', 'calendar-signed-in')
        : c.redirect('/admin/calendars', 302);
    }
    const listed = await listMicrosoftCalendars(deps.fetcher, endpoints, polled.accessToken);
    if (!listed.ok) return c.html(microsoftPage(c, held, listed.message), 400);
    return pickPage(c, {
      step: 'pick',
      provider: 'microsoft',
      clientId: held.clientId,
      tenant: held.tenant,
      refreshToken,
      ...(polled.label === undefined ? {} : { label: polled.label }),
      calendars: listed.calendars,
    });
  });

  /* ---- Google: the browser redirect ------------------------------------ */

  app.get('/admin/calendars/new/google', (c: Context) => c.html(googlePage(c, {})));

  app.post('/admin/calendars/google/start', async (c: Context) => {
    const redirectUri = googleRedirectUri(deps.baseUrl);
    if (redirectUri === undefined) return c.html(googlePage(c, {}), 400);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const again = parse(accountBody, body);
    let clientId: string;
    let clientSecret: string;
    let reauth: string | undefined;
    if (again.ok) {
      const stored = account(again.value.account);
      const secret = stored === undefined ? undefined : storedSecret(stored.id);
      if (stored === undefined || stored.provider !== 'google' || secret === undefined) {
        return c.redirect('/admin/calendars', 302);
      }
      clientId = stored.clientId;
      clientSecret = secret;
      reauth = stored.id;
    } else {
      const shaped = parse(googleStartBody, body);
      // The client ID is echoed; the secret never is, refused or not.
      const echo = typeof body['client_id'] === 'string' ? body['client_id'].slice(0, 200) : '';
      if (!shaped.ok) return c.html(googlePage(c, { clientId: echo }, shaped.message), 400);
      clientId = shaped.value.client_id;
      clientSecret = shaped.value.client_secret;
    }
    const { verifier, challenge } = pkce();
    const state = holdPendingOAuth(
      { step: 'google-consent', clientId, clientSecret, redirectUri, verifier, ...(reauth === undefined ? {} : { reauth }) },
      now(),
    );
    return c.redirect(googleConsentUrl(endpoints, { clientId, redirectUri, state, challenge }), 302);
  });

  app.get('/admin/calendars/google/callback', async (c: Context) => {
    const state = c.req.query('state') ?? '';
    const held = PENDING_ID.test(state) ? readPendingOAuth(state, now()) : undefined;
    if (held === undefined || held.step !== 'google-consent') {
      return c.html(
        googlePage(c, {}, 'That sign-in is not one this wall started, or it took too long and was forgotten. Start it again.'),
        400,
      );
    }
    dropPendingOAuth(state);
    const echo = { clientId: held.clientId };
    const refused = c.req.query('error');
    if (refused !== undefined) {
      return c.html(
        googlePage(
          c,
          echo,
          refused === 'access_denied'
            ? 'The sign-in was cancelled at Google, so nothing was added.'
            : 'Google did not finish the sign-in. Check the redirect address in Google Cloud matches the one on this page.',
        ),
        400,
      );
    }
    const code = c.req.query('code') ?? '';
    if (code === '' || code.length > 2000) {
      return c.html(googlePage(c, echo, 'Google came back without a sign-in. Start it again.'), 400);
    }
    const exchanged = await exchangeGoogleCode(deps.fetcher, endpoints, {
      clientId: held.clientId,
      clientSecret: held.clientSecret,
      code,
      redirectUri: held.redirectUri,
      verifier: held.verifier,
    });
    if (!exchanged.ok) return c.html(googlePage(c, echo, exchanged.message), 400);
    const refreshToken = exchanged.refreshToken ?? '';
    if (held.reauth !== undefined) {
      return replaceOAuthTokens(deps.db, deps.keyring, held.reauth, refreshToken, exchanged.label, now())
        ? savedRedirect(c, '/admin/calendars', 'calendar-signed-in')
        : c.redirect('/admin/calendars', 302);
    }
    const listed = await listGoogleCalendars(deps.fetcher, endpoints, exchanged.accessToken);
    if (!listed.ok) return c.html(googlePage(c, echo, listed.message), 400);
    return pickPage(c, {
      step: 'pick',
      provider: 'google',
      clientId: held.clientId,
      clientSecret: held.clientSecret,
      refreshToken,
      ...(exchanged.label === undefined ? {} : { label: exchanged.label }),
      calendars: listed.calendars,
    });
  });

  /* ---- Both: picking, adding more, removing ---------------------------- */

  /**
   * More calendars from an account already signed in: the stored sign-in
   * lists them, and the ones already on the wall are left out.
   */
  app.get('/admin/calendars/oauth/:id/more', async (c: Context) => {
    const stored = account(c.req.param('id') ?? '');
    if (stored === undefined) return c.redirect('/admin/calendars', 302);
    const token = await accessToken(context(), endpoints, stored.id);
    if (!token.ok) return c.html(accountProblemPage(c, stored, token.message), 400);
    const listed =
      stored.provider === 'google'
        ? await listGoogleCalendars(deps.fetcher, endpoints, token.token)
        : await listMicrosoftCalendars(deps.fetcher, endpoints, token.token);
    if (!listed.ok) return c.html(accountProblemPage(c, stored, listed.message), 400);
    const have = new Set(calendarIdsOf(stored.id));
    return pickPage(c, {
      step: 'pick',
      provider: stored.provider,
      accountId: stored.id,
      clientId: stored.clientId,
      calendars: listed.calendars.filter((calendar) => !have.has(calendar.id)),
    });
  });

  app.post('/admin/calendars/oauth/add', async (c: Context) => {
    const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const shaped = parse(pickBody, body);
    const held = shaped.ok ? readPendingOAuth(shaped.value.pending, now()) : undefined;
    if (!shaped.ok || held === undefined || held.step !== 'pick') {
      return c.html(
        page({
          self: selfHref(c),
          modules: navModules(deps.db),
          title: 'Add a calendar — Maverick Wall',
          nav: 'calendars',
          heading: 'That took too long',
          back: { label: 'Add a calendar', href: 'admin/calendars/new' },
          body: errorBlock('The sign-in was forgotten before the calendars were chosen. Sign in again.'),
        }),
        400,
      );
    }
    /*
     * The ticked calendars by their place in the list this page drew, and only
     * those: the POST is the boundary, so an index outside the held list is
     * ignored rather than trusted, and no calendar id is ever read from the
     * body — the page never carried one.
     */
    const raw = body['calendar'];
    const ticked = new Set((Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string'));
    const picked = held.calendars.filter((_, index) => ticked.has(String(index)));
    if (picked.length === 0) {
      // Nothing ticked is somebody who changed their mind; the honest answer
      // is the page they came from, and the sign-in is not kept.
      dropPendingOAuth(shaped.value.pending);
      return c.redirect('/admin/calendars', 302);
    }
    const owner = shaped.value.person_id;
    const personId = owner !== undefined && readPeopleAdmin(deps.db).some((p) => p.id === owner) ? owner : null;
    const at = now();
    const accountId =
      held.accountId ??
      createOAuthAccount(
        deps.db,
        deps.keyring,
        {
          provider: held.provider,
          clientId: held.clientId,
          ...(held.clientSecret === undefined ? {} : { clientSecret: held.clientSecret }),
          ...(held.tenant === undefined ? {} : { tenant: held.tenant }),
          refreshToken: held.refreshToken ?? '',
          ...(held.label === undefined ? {} : { label: held.label }),
        },
        at,
      );
    for (const calendar of picked) {
      addOAuthCalendar(
        deps.db,
        deps.keyring,
        endpoints,
        { accountId, provider: held.provider, calendarId: calendar.id, name: calendar.name.slice(0, 80) || 'Calendar', personId },
        at,
      );
    }
    dropPendingOAuth(shaped.value.pending);
    return savedRedirect(c, '/admin/calendars', 'calendar-added');
  });

  app.get('/admin/calendars/oauth/:id/delete', (c: Context) => {
    const stored = account(c.req.param('id') ?? '');
    if (stored === undefined) return c.redirect('/admin/calendars', 302);
    const calendars = readAdminSources(deps.db).filter((source) => source.oauthAccountId === stored.id);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: `Remove ${providerName(stored.provider)} account`,
        nav: 'calendars',
        heading: `Remove ${stored.accountLabel ?? `this ${providerName(stored.provider)} account`}?`,
        intro:
          `Its ${calendars.length} calendar${calendars.length === 1 ? '' : 's'} disappear from the wall ` +
          `immediately and the sign-in is forgotten, so adding them back later means signing in again. ` +
          `Nothing at ${providerName(stored.provider)} is changed — to stop the app working there too, ` +
          `remove its access in your ${providerName(stored.provider)} account as well.`,
        ...(calendars.length === 0
          ? {}
          : {
              body:
                `<p class="hint">Going: ` +
                calendars.map((source) => escapeHtml(source.name)).join(', ') +
                `. To remove just one of them, use its own Remove instead.</p>`,
            }),
        destroyAction: `admin/calendars/oauth/${encodeURIComponent(stored.id)}/delete`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/calendars',
      }),
    );
  });

  app.post('/admin/calendars/oauth/:id/delete', (c: Context) =>
    removeOAuthAccount(deps.db, c.req.param('id') ?? '')
      ? savedRedirect(c, '/admin/calendars', 'calendar-removed')
      : c.redirect('/admin/calendars', 302),
  );

  /* ---- Pages ----------------------------------------------------------- */

  function storedSecret(accountId: string): string | undefined {
    const row = deps.db
      .prepare('SELECT client_secret_encrypted AS secret FROM oauth_accounts WHERE id = ?')
      .get(accountId) as { secret: string | null } | undefined;
    if (row?.secret == null) return undefined;
    const opened = deps.keyring.decrypt(row.secret, 'oauth-client-secret');
    return opened.ok ? opened.value : undefined;
  }

  /** The provider ids of the calendars already added from an account. */
  function calendarIdsOf(accountId: string): string[] {
    const rows = deps.db
      .prepare('SELECT url_encrypted AS sealed FROM calendar_sources WHERE oauth_account_id = ?')
      .all(accountId) as { sealed: string }[];
    return rows.flatMap((row) => {
      const opened = deps.keyring.decrypt(row.sealed, 'calendar-source-url');
      return opened.ok ? [opened.value] : [];
    });
  }

  function pickPage(c: Context, held: Extract<PendingOAuth, { step: 'pick' }>): ReturnType<Context['html']> {
    const people = readPeopleAdmin(deps.db);
    const name = providerName(held.provider);
    const signedIn = held.label === undefined ? `Signed in to ${name}.` : `Signed in to ${name} as ${held.label}.`;
    if (held.calendars.length === 0) {
      return c.html(
        page({
          self: selfHref(c),
          modules: navModules(deps.db),
          title: 'Which calendars? — Maverick Wall',
          nav: 'calendars',
          heading: 'Which calendars?',
          back: { label: 'Calendars', href: 'admin/calendars' },
          body: emptyState(
            held.accountId === undefined
              ? `${signedIn} That account has no calendars to read.`
              : 'Every calendar on this account is already on the wall.',
          ),
        }),
      );
    }
    const id = holdPendingOAuth(held, now());
    return c.html(
      page({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Which calendars? — Maverick Wall',
        nav: 'calendars',
        heading: 'Which calendars?',
        back: { label: 'Calendars', href: 'admin/calendars' },
        intro: `${held.accountId === undefined ? `${signedIn} ` : ''}Tick the ones to put on the wall — you can add more later.`,
        body: card(
          `<form method="post" action="admin/calendars/oauth/add">` +
            `<input type="hidden" name="pending" value="${escapeHtml(id)}">` +
            held.calendars
              .map((calendar, index) =>
                switchRow({
                  label: calendar.primary ? `${calendar.name} (main calendar)` : calendar.name,
                  name: 'calendar',
                  checked: held.accountId === undefined ? calendar.primary : false,
                  value: String(index),
                }),
              )
              .join('') +
            (people.length === 0
              ? ''
              : selectField({
                  label: 'Belongs to',
                  name: 'person_id',
                  hint: 'When a calendar belongs to someone, its events take their colour on the wall.',
                  optionsHtml:
                    `<option value="" selected>Everyone</option>` +
                    people
                      .map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`)
                      .join(''),
                })) +
            `<div class="row"><button type="submit">Add them</button></div></form>`,
        ),
      }),
    );
  }

  function accountProblemPage(c: Context, stored: OAuthAccountRow, message: string): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a calendar — Maverick Wall',
      nav: 'calendars',
      heading: `${providerName(stored.provider)} did not answer`,
      back: { label: 'Calendars', href: 'admin/calendars' },
      body: errorBlock(message, 'Sign the account in again on the Calendars screen if this keeps happening.'),
    });
  }

  function microsoftPage(c: Context, echo: MicrosoftEcho, error?: string): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Sign in to Microsoft 365 — Maverick Wall',
      nav: 'calendars',
      heading: 'Sign in to Microsoft 365',
      back: { label: 'Add a calendar', href: 'admin/calendars/new' },
      intro:
        'For a work or school Microsoft 365 account, or a personal Outlook.com one. You sign in on ' +
        'Microsoft’s own page, on any phone or computer, so this wall never sees your password.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        section(
          'First, an app of your own',
          'Microsoft only lets an app that is registered with it read a calendar, and Maverick Wall ' +
            'uses yours rather than one it shares with every other household. It takes about five minutes, once.',
          `<ol class="wset-steps">` +
            `<li>In the <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">Microsoft Entra admin centre</a>, ` +
            `open <strong>App registrations</strong> and choose <strong>New registration</strong>. Call it Maverick Wall. ` +
            `For a personal Outlook.com account choose <em>Accounts in any organizational directory and personal ` +
            `Microsoft accounts</em>. Leave the redirect address empty.</li>` +
            `<li>Under <strong>Authentication</strong>, turn on <strong>Allow public client flows</strong> and save.</li>` +
            `<li>Under <strong>API permissions</strong>, add <strong>Microsoft Graph</strong> › <em>Delegated</em> › ` +
            `<strong>Calendars.ReadBasic</strong>. It reads when events are and what they are called, and cannot change anything.</li>` +
            `<li>Copy the <strong>Application (client) ID</strong> from the app’s overview.</li>` +
            `</ol>`,
        ) +
        section(
          'Then sign in',
          undefined,
          `<form method="post" action="admin/calendars/microsoft/start">` +
            textField({
              label: 'Application (client) ID',
              name: 'client_id',
              required: true,
              value: echo.clientId ?? '',
              placeholder: '1a2b3c4d-…',
              attrs: 'autocomplete="off" spellcheck="false"',
            }) +
            textField({
              label: 'Directory (tenant)',
              name: 'tenant',
              value: echo.tenant ?? 'common',
              hint:
                'Leave as common if the app takes personal and work accounts. If you registered it for your ' +
                'organisation only, put your Directory (tenant) ID here instead — Microsoft refuses common for those.',
              attrs: 'autocomplete="off" spellcheck="false"',
            }) +
            `<div class="row"><button type="submit">Get a sign-in code</button></div></form>`,
        ),
    });
  }

  function microsoftCodePage(c: Context, id: string, userCode: string, verificationUri: string, notice?: string): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Sign in to Microsoft 365 — Maverick Wall',
      nav: 'calendars',
      heading: 'Enter this code at Microsoft',
      back: { label: 'Add a calendar', href: 'admin/calendars/new' },
      body:
        (notice === undefined ? '' : noticeBlock(notice)) +
        card(
          `<pre class="code">${escapeHtml(userCode)}</pre>` +
            `<p>Open <a href="${escapeHtml(verificationUri)}" target="_blank" rel="noopener noreferrer">` +
            `${escapeHtml(verificationUri)}</a> on this or any other device, type the code, and sign in to the ` +
            `account whose calendars you want on the wall. Then come back here.</p>` +
            `<p class="hint">The code lasts fifteen minutes.</p>` +
            `<form method="post" action="admin/calendars/microsoft/poll">` +
            `<input type="hidden" name="pending" value="${escapeHtml(id)}">` +
            `<div class="row"><button type="submit">I have signed in</button></div></form>`,
        ),
    });
  }

  function googlePage(c: Context, echo: { clientId?: string }, error?: string): string {
    const redirectUri = googleRedirectUri(deps.baseUrl);
    const head = {
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Sign in to Google Calendar — Maverick Wall',
      nav: 'calendars',
      heading: 'Sign in to Google Calendar',
      back: { label: 'Add a calendar', href: 'admin/calendars/new' },
    };
    if (redirectUri === undefined) {
      return page({
        ...head,
        body:
          (error === undefined ? '' : errorBlock(error)) +
          section(
            'This wall needs a public https address first',
            undefined,
            `<p>Google sends a sign-in back to the address of the thing that asked for it, and only to an ` +
              `https address on a public domain. This wall’s address is <strong>${escapeHtml(deps.baseUrl)}</strong>, ` +
              `which Google will not send one to.</p>` +
              `<p>If you reach this wall from outside your home through your own domain or Home Assistant Cloud, ` +
              `set that https address as the wall’s address (the <code>base_url</code> option, or ` +
              `<code>BASE_URL</code>) and this page will offer the sign-in.</p>` +
              `<p>Until then, either of these works on any install:</p>` +
              `<ul class="plain">` +
              `<li><a href="admin/calendars/new/address">Google’s secret iCal address</a> — in Google Calendar, a ` +
              `calendar’s Settings › Integrate calendar. Google refreshes it on its own schedule, sometimes hours behind.</li>` +
              `<li><a href="admin/home-assistant">Home Assistant’s Google Calendar integration</a>, and the calendar ` +
              `added from Home Assistant.</li>` +
              `</ul>`,
          ),
      });
    }
    return page({
      ...head,
      intro:
        'You sign in on Google’s own page, so this wall never sees your password. It asks only to read ' +
        'your calendars, and cannot change them.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        section(
          'First, an app of your own',
          'Google only lets an app it knows about read a calendar, and Maverick Wall uses yours rather than one ' +
            'it shares with every other household. It takes about ten minutes, once.',
          `<ol class="wset-steps">` +
            `<li>In <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer">Google Cloud</a>, ` +
            `create a project and turn on the <strong>Google Calendar API</strong> for it.</li>` +
            `<li>Set up the <strong>OAuth consent screen</strong> as <em>External</em>, and add your own Google ` +
            `address as a test user.</li>` +
            `<li>Under <strong>Clients</strong>, create a <em>Web application</em> client, and add this exact ` +
            `address under <strong>Authorized redirect URIs</strong>:` +
            `<pre class="code">${escapeHtml(redirectUri)}</pre></li>` +
            `<li>Copy the client ID and the client secret.</li>` +
            `</ol>` +
            noticeBlock(
              'While the app is in Testing, Google signs this wall out every seven days.',
              'The calendars stop updating and this screen says so; signing in again fixes it for another week. ' +
                'Publishing the app (OAuth consent screen › Publish app) ends the weekly sign-out. Google will ' +
                'then warn that the app is unverified when you sign in, which is expected for an app only you use.',
            ),
        ) +
        section(
          'Then sign in',
          undefined,
          // `_top`, because Google refuses to be drawn inside a frame, and the
          // Home Assistant sidebar is one.
          `<form method="post" action="admin/calendars/google/start" target="_top">` +
            textField({
              label: 'Client ID',
              name: 'client_id',
              required: true,
              value: echo.clientId ?? '',
              placeholder: '1234…apps.googleusercontent.com',
              attrs: 'autocomplete="off" spellcheck="false"',
            }) +
            textField({
              label: 'Client secret',
              name: 'client_secret',
              type: 'password',
              required: true,
              attrs: 'autocomplete="off" spellcheck="false"',
            }) +
            `<p class="hint">If this wall is open in the Home Assistant sidebar, Google sends you back to ` +
            `${escapeHtml(new URL(redirectUri).origin)}, where you may be asked to sign in to Maverick Wall once.</p>` +
            `<div class="row"><button type="submit">Sign in with Google</button></div></form>`,
        ),
    });
  }
}

/**
 * The signed-in accounts on the Calendars list, each with its calendars and
 * the two things a household does to one: sign in again, and add another.
 *
 * `caldavAccountsSection`'s shape, for its reason: one account is one sign-in,
 * so a refused one is said once against the account, with the one control that
 * fixes every calendar on it.
 */
export function oauthAccountsSection(accounts: readonly OAuthAccountRow[], sources: readonly AdminSourceRow[]): string {
  if (accounts.length === 0) return '';
  return section(
    'Signed-in accounts',
    'One sign-in, and the calendars it reaches. Signing in again fixes all of them at once.',
    accounts
      .map((account) => {
        const mine = sources.filter((source) => source.oauthAccountId === account.id);
        const id = encodeURIComponent(account.id);
        const name = providerName(account.provider);
        return card(
          listRow(
            '',
            { title: account.accountLabel ?? name, detail: name },
            tag(`${mine.length} calendar${mine.length === 1 ? '' : 's'}`, 'neutral'),
          ) +
            (account.lastError === null ? '' : errorBlock(account.lastError, 'Sign in again below.')) +
            (mine.length === 0
              ? emptyState('No calendars from this account are on the wall.')
              : mine
                  .map((source) =>
                    listRow(
                      '',
                      {
                        title: source.name,
                        detail:
                          source.lastError !== null
                            ? 'Last sync failed'
                            : `${source.eventCount} event${source.eventCount === 1 ? '' : 's'}`,
                      },
                      source.lastError !== null ? tag('Problem', 'danger') : '',
                    ),
                  )
                  .join('')) +
            `<div class="row">` +
            signInAgain(account.provider, account.id) +
            `<a class="btn btn-ghost" href="admin/calendars/oauth/${id}/more">Add another calendar</a>` +
            `</div>` +
            destructive('Remove account', {
              thing: `${account.accountLabel ?? name} and its ${mine.length} calendar${mine.length === 1 ? '' : 's'}`,
              confirmAction: `admin/calendars/oauth/${id}/delete`,
              variant: 'button',
            }),
          account.lastError !== null ? { tone: 'danger' } : {},
        );
      })
      .join(''),
  );
}

function signInAgain(provider: OAuthProvider, accountId: string): string {
  return (
    `<form method="post" action="admin/calendars/${provider}/start"${provider === 'google' ? ' target="_top"' : ''}>` +
    `<input type="hidden" name="account" value="${escapeHtml(accountId)}">` +
    `<button class="secondary" type="submit">Sign in again</button></form>`
  );
}
