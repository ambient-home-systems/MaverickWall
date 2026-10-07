import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { OAuthEndpoints } from '../src/oauth/endpoints.js';

/**
 * A stand-in for Google's and Microsoft's sign-in and calendar APIs (plan item
 * M5.11), on loopback.
 *
 * Built from the providers' documentation rather than from memory, and from
 * the parts this application uses:
 *
 * - **Google**: `POST /token` takes `authorization_code` (with the PKCE
 *   verifier, which it checks against the challenge the consent URL carried)
 *   and `refresh_token`; a refused grant answers 400 `invalid_grant`, which is
 *   what a Testing app's seven-day expiry looks like. `GET
 *   /calendar/v3/users/me/calendarList` and `/calendars/{id}/events` page by
 *   `nextPageToken`.
 * - **Microsoft**: `POST /{tenant}/oauth2/v2.0/devicecode` and `/token`, where
 *   the device-code grant answers 400 `authorization_pending` until a test
 *   says the household finished, and a refresh rotates the refresh token, as
 *   Microsoft's does. Graph's `/me/calendars` and `calendarView` page by
 *   `@odata.nextLink`, and the view requires `Prefer: outlook.timezone="UTC"`.
 *
 * Every request is recorded with its method, path, content type, form body and
 * bearer, so a test can say what left the server and how.
 */

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly form: Record<string, string>;
  readonly authorization: string | undefined;
  readonly prefer: string | undefined;
}

export interface FakeOAuth {
  readonly endpoints: OAuthEndpoints;
  readonly requests: FakeRequest[];
  /** Google: what the account is called and holds. */
  readonly google: {
    clientId: string;
    clientSecret: string;
    email: string;
    calendars: { id: string; summary: string; primary?: boolean }[];
    events: Record<string, unknown[]>;
    /** While set, every refresh answers `invalid_grant`. */
    revoked: boolean;
  };
  readonly microsoft: {
    clientId: string;
    name: string;
    calendars: { id: string; name: string; isDefaultCalendar?: boolean }[];
    events: Record<string, unknown[]>;
    /** Has the household finished at microsoft.com/devicelogin? */
    approved: boolean;
    /** While set, the device-code grant answers this error instead. */
    deviceError: string | undefined;
    revoked: boolean;
  };
  /** How many items a page holds, to make paging happen. */
  pageSize: number;
  /** Access tokens currently honoured. */
  readonly access: Set<string>;
  /** Refresh tokens currently honoured, by provider. */
  readonly refresh: Map<string, 'google' | 'microsoft'>;
  /**
   * What Google's consent page would hand the household's browser: a code for
   * the challenge and redirect address the consent URL carried.
   */
  consent(consentUrl: string): { code: string; state: string; redirectUri: string };
  close(): Promise<void>;
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}

export async function fakeOAuth(): Promise<FakeOAuth> {
  const requests: FakeRequest[] = [];
  const access = new Set<string>();
  const refresh = new Map<string, 'google' | 'microsoft'>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const deviceCodes = new Set<string>();
  const state = {
    google: {
      clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-fake-secret-0123456789',
      email: 'family@example.com',
      calendars: [] as FakeOAuth['google']['calendars'],
      events: {} as Record<string, unknown[]>,
      revoked: false,
    },
    microsoft: {
      clientId: '1a2b3c4d-1111-2222-3333-444455556666',
      name: 'jane@contoso.example',
      calendars: [] as FakeOAuth['microsoft']['calendars'],
      events: {} as Record<string, unknown[]>,
      approved: false,
      deviceError: undefined as string | undefined,
      revoked: false,
    },
    pageSize: 250,
  };
  let base = '';
  const mint = (prefix: string): string => `${prefix}-${randomBytes(12).toString('hex')}`;
  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const tokens = (provider: 'google' | 'microsoft', withRefresh: boolean): Record<string, unknown> => {
    const token = mint(`${provider}-access`);
    access.add(token);
    const out: Record<string, unknown> = { access_token: token, expires_in: 3599, token_type: 'Bearer' };
    if (withRefresh) {
      const next = mint(`${provider}-refresh`);
      refresh.set(next, provider);
      out['refresh_token'] = next;
    }
    out['id_token'] =
      provider === 'google'
        ? idToken({ iss: 'https://accounts.google.com', email: state.google.email, sub: '1' })
        : idToken({ preferred_username: state.microsoft.name, name: 'Jane' });
    return out;
  };
  const page = (all: unknown[], offset: number): { items: unknown[]; next: number | undefined } => {
    const items = all.slice(offset, offset + state.pageSize);
    return { items, next: offset + state.pageSize < all.length ? offset + state.pageSize : undefined };
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const contentType = request.headers['content-type'];
      const form = (contentType ?? '').startsWith('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(raw))
        : {};
      requests.push({
        method: request.method ?? '',
        path: url.pathname,
        contentType,
        form,
        authorization: request.headers.authorization,
        prefer: typeof request.headers.prefer === 'string' ? request.headers.prefer : undefined,
      });

      // ---- Google's token endpoint
      if (request.method === 'POST' && url.pathname === '/google/token') {
        if (form['client_id'] !== state.google.clientId || form['client_secret'] !== state.google.clientSecret) {
          send(response, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
          return;
        }
        if (form['grant_type'] === 'authorization_code') {
          const held = codes.get(form['code'] ?? '');
          const challenge = createHash('sha256').update(form['code_verifier'] ?? '').digest('base64url');
          if (held === undefined || held.challenge !== challenge || held.redirectUri !== form['redirect_uri']) {
            send(response, 400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
            return;
          }
          codes.delete(form['code'] ?? '');
          send(response, 200, { ...tokens('google', true), scope: 'openid email calendar.readonly' });
          return;
        }
        if (form['grant_type'] === 'refresh_token') {
          if (state.google.revoked || refresh.get(form['refresh_token'] ?? '') !== 'google') {
            send(response, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            return;
          }
          // Google keeps the refresh token it already gave.
          send(response, 200, tokens('google', false));
          return;
        }
        send(response, 400, { error: 'unsupported_grant_type' });
        return;
      }

      // ---- Microsoft's device-code and token endpoints
      const ms = /^\/ms\/([^/]+)\/oauth2\/v2\.0\/(devicecode|token)$/.exec(url.pathname);
      if (request.method === 'POST' && ms !== null) {
        if (form['client_id'] !== state.microsoft.clientId) {
          send(response, 400, {
            error: 'unauthorized_client',
            error_description: "AADSTS700016: Application with identifier was not found in the directory.",
          });
          return;
        }
        if (ms[2] === 'devicecode') {
          const deviceCode = mint('device');
          deviceCodes.add(deviceCode);
          send(response, 200, {
            device_code: deviceCode,
            user_code: 'FAKE1234',
            verification_uri: 'https://microsoft.com/devicelogin',
            expires_in: 900,
            interval: 5,
            message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin.',
          });
          return;
        }
        if (form['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (!deviceCodes.has(form['device_code'] ?? '')) {
            send(response, 400, { error: 'expired_token', error_description: 'AADSTS70019: expired.' });
            return;
          }
          if (state.microsoft.deviceError !== undefined) {
            send(response, 400, { error: state.microsoft.deviceError, error_description: 'AADSTS70016: pending.' });
            return;
          }
          if (!state.microsoft.approved) {
            send(response, 400, { error: 'authorization_pending', error_description: 'AADSTS70016: pending.' });
            return;
          }
          deviceCodes.delete(form['device_code'] ?? '');
          send(response, 200, tokens('microsoft', true));
          return;
        }
        if (form['grant_type'] === 'refresh_token') {
          const presented = form['refresh_token'] ?? '';
          if (state.microsoft.revoked || refresh.get(presented) !== 'microsoft') {
            send(response, 400, {
              error: 'invalid_grant',
              error_description: 'AADSTS70008: The refresh token has expired due to inactivity.',
            });
            return;
          }
          // Microsoft rotates: the old one stops working, a new one comes back.
          refresh.delete(presented);
          send(response, 200, tokens('microsoft', true));
          return;
        }
        send(response, 400, { error: 'unsupported_grant_type' });
        return;
      }

      // ---- The two APIs, behind a bearer
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!access.has(bearer)) {
        send(response, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/google/calendar/v3/users/me/calendarList') {
        const at = Number(url.searchParams.get('pageToken') ?? 0);
        const { items, next } = page(
          state.google.calendars.map((one) => ({ kind: 'calendar#calendarListEntry', accessRole: 'owner', ...one })),
          at,
        );
        send(response, 200, { kind: 'calendar#calendarList', items, ...(next === undefined ? {} : { nextPageToken: String(next) }) });
        return;
      }
      const googleEvents = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === 'GET' && googleEvents !== null) {
        const id = decodeURIComponent(googleEvents[1] ?? '');
        const all = state.google.events[id];
        if (all === undefined) {
          send(response, 404, { error: { code: 404, message: 'Not Found' } });
          return;
        }
        const at = Number(url.searchParams.get('pageToken') ?? 0);
        const { items, next } = page(all, at);
        send(response, 200, { kind: 'calendar#events', items, ...(next === undefined ? {} : { nextPageToken: String(next) }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/graph/v1.0/me/calendars') {
        send(response, 200, { value: state.microsoft.calendars.map((one) => ({ canEdit: true, ...one })) });
        return;
      }
      const view = /^\/graph\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(url.pathname);
      if (request.method === 'GET' && view !== null) {
        const all = state.microsoft.events[decodeURIComponent(view[1] ?? '')];
        if (all === undefined) {
          send(response, 404, { error: { code: 'ErrorItemNotFound', message: 'Not found.' } });
          return;
        }
        if (request.headers.prefer !== 'outlook.timezone="UTC"') {
          send(response, 400, { error: { code: 'TestFake', message: 'Ask for UTC.' } });
          return;
        }
        const at = Number(url.searchParams.get('$skip') ?? 0);
        const { items, next } = page(all, at);
        const nextUrl = new URL(url.toString().replace('http://localhost', base));
        nextUrl.searchParams.set('$skip', String(next ?? 0));
        send(response, 200, { value: items, ...(next === undefined ? {} : { '@odata.nextLink': nextUrl.toString() }) });
        return;
      }
      send(response, 404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const endpoints: OAuthEndpoints = {
    googleAuth: `${base}/google/auth`,
    googleToken: `${base}/google/token`,
    googleApi: `${base}/google/calendar/v3`,
    microsoftLogin: `${base}/ms`,
    graph: `${base}/graph/v1.0`,
    policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
  };
  const out = Object.assign(state, {
    endpoints,
    requests,
    access,
    refresh,
    consent(consentUrl: string) {
      const url = new URL(consentUrl);
      const code = mint('code');
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
        clientId: url.searchParams.get('client_id') ?? '',
      });
      return { code, state: url.searchParams.get('state') ?? '', redirectUri };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return out as unknown as FakeOAuth;
}
