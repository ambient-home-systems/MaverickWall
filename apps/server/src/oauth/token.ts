import { FETCH_LIMITS, type Fetcher, type FetchOutcome } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../net/fetcher.js';
import { parseJsonOr, z } from '../validation.js';
import { GOOGLE_SCOPES, MICROSOFT_SCOPES, type OAuthEndpoints, type OAuthProvider } from './endpoints.js';

/**
 * Every token request a calendar sign-in makes (plan item M5.11), and the only
 * place in this application that POSTs to Google or Microsoft.
 *
 * Three addresses, all built here from `OAuthEndpoints` and never from
 * anything a household typed: Google's token endpoint, and Microsoft's device
 * code and token endpoints under the household's directory. Every request is
 * a form (`bodyType: 'form'`), because that is what OAuth's token endpoints
 * read, and every one keeps its refusal's body, because a refusal is the
 * answer here: "not signed in yet" arrives as a 400 with
 * `{"error": "authorization_pending"}`. `ha-write-boundary.test.ts` admits
 * this file's one POST by name and holds it to these three addresses.
 *
 * Nothing in this file writes a token anywhere. It hands tokens back, and
 * `oauth/accounts.ts` seals the refresh token before it is stored.
 */

type Target =
  | { readonly kind: 'google-token' }
  | { readonly kind: 'microsoft-devicecode'; readonly tenant: string }
  | { readonly kind: 'microsoft-token'; readonly tenant: string };

/** A Microsoft directory: one of the three aliases, a tenant id or a verified domain. */
export const MICROSOFT_TENANT = /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9.-]{0,200}\.[a-z]{2,63})$/i;

function targetUrl(target: Target, endpoints: OAuthEndpoints): string {
  switch (target.kind) {
    case 'google-token':
      return endpoints.googleToken;
    case 'microsoft-devicecode':
      return `${endpoints.microsoftLogin}/${encodeURIComponent(target.tenant)}/oauth2/v2.0/devicecode`;
    case 'microsoft-token':
      return `${endpoints.microsoftLogin}/${encodeURIComponent(target.tenant)}/oauth2/v2.0/token`;
  }
}

async function postForm(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  target: Target,
  form: Readonly<Record<string, string>>,
): Promise<FetchOutcome> {
  return fetcher.fetch({
    url: targetUrl(target, endpoints),
    policy: endpoints.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 15_000,
    userAgent: DEFAULT_USER_AGENT,
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    bodyType: 'form',
    keepErrorBody: true,
  });
}

const errorShape = z.object({
  error: z.string().max(200),
  error_description: z.string().max(4000).optional().catch(undefined),
});

/** The provider's refusal, as its two words, or nothing when it said none. */
function refusalOf(outcome: FetchOutcome): { readonly error: string; readonly description: string } | undefined {
  if (outcome.status !== 'failed' || outcome.responseBody === undefined) return undefined;
  const parsed = parseJsonOr(errorShape.optional().catch(undefined), outcome.responseBody, undefined);
  return parsed === undefined ? undefined : { error: parsed.error, description: parsed.error_description ?? '' };
}

const tokenShape = z.object({
  access_token: z.string().min(1).max(20_000),
  expires_in: z.coerce.number().int().positive().max(86_400 * 30).catch(3600),
  refresh_token: z.string().min(1).max(20_000).optional().catch(undefined),
  id_token: z.string().max(20_000).optional().catch(undefined),
});

/**
 * The account's name, out of an id token, for the Calendars screen.
 *
 * **Read, never trusted.** The id token is decoded and not verified, because
 * nothing here rests on it: it names an account on a settings page so two can
 * be told apart, and a forged one could only mislabel the household's own
 * account to the household. Nothing is authorised on it.
 */
export function labelFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const key of ['email', 'preferred_username', 'name']) {
      const value = claims[key];
      if (typeof value === 'string' && value !== '' && value.length <= 200) return value;
    }
  } catch {
    // An id token that is not one is an account with no name to show.
  }
  return undefined;
}

export interface Tokens {
  readonly accessToken: string;
  readonly expiresInSec: number;
  /** Microsoft sends a new one with every refresh; Google sends one only when it is first granted. */
  readonly refreshToken?: string;
  readonly label?: string;
}

export type TokenResult =
  | ({ readonly ok: true } & Tokens)
  | {
      readonly ok: false;
      /**
       * `revoked` is a sign-in the provider no longer honours, which waiting
       * will not fix and signing in again will; `refused` is everything else
       * the provider said no to; `unreachable` is a network that did not get
       * there.
       */
      readonly reason: 'revoked' | 'refused' | 'unreachable';
      readonly message: string;
    };

function tokensFrom(body: string): Tokens | undefined {
  const parsed = tokenShape.safeParse(parseJsonOr(z.unknown(), body, undefined));
  if (!parsed.success) return undefined;
  const label = labelFromIdToken(parsed.data.id_token);
  return {
    accessToken: parsed.data.access_token,
    expiresInSec: parsed.data.expires_in,
    ...(parsed.data.refresh_token === undefined ? {} : { refreshToken: parsed.data.refresh_token }),
    ...(label === undefined ? {} : { label }),
  };
}

/** A refusal, said for somebody standing in a kitchen, naming the one thing that fixes it. */
function refusalMessage(provider: OAuthProvider, error: string, description: string): TokenResult {
  const name = provider === 'google' ? 'Google' : 'Microsoft';
  // Microsoft's own codes ride in the description: AADSTS65001 is consent
  // nobody has given, AADSTS700016 an app it cannot find.
  if (/AADSTS(65001|90094|90008)/.test(description) || error === 'consent_required') {
    return {
      ok: false,
      reason: 'refused',
      message:
        'Your organisation has to approve this app before it can read calendars. Ask whoever runs ' +
        'its Microsoft 365, or sign in with a personal account.',
    };
  }
  if (error === 'invalid_grant') {
    return {
      ok: false,
      reason: 'revoked',
      message:
        provider === 'google'
          ? 'Google stopped accepting this sign-in. A Google app left in Testing signs everybody out ' +
            'after seven days: sign in again on the Calendars screen, and publish the app in the Google ' +
            'Cloud console to stop it happening again.'
          : 'Microsoft stopped accepting this sign-in. Sign in again on the Calendars screen.',
    };
  }
  if (error === 'invalid_client' || /AADSTS700016/.test(description)) {
    return {
      ok: false,
      reason: 'refused',
      message:
        provider === 'google'
          ? 'Google did not recognise the app’s client ID or secret. Check both against the Google Cloud console.'
          : 'Microsoft did not recognise the app’s client ID. Check it in the Microsoft Entra admin centre.',
    };
  }
  if (error === 'unauthorized_client' || /AADSTS7000218/.test(description)) {
    return {
      ok: false,
      reason: 'refused',
      message:
        provider === 'microsoft'
          ? 'This app is not allowed to sign in with a code. In the Microsoft Entra admin centre, under ' +
            'Authentication, turn on “Allow public client flows”.'
          : 'Google did not allow this app to sign in that way. Check that it is a “Web application” client.',
    };
  }
  return { ok: false, reason: 'refused', message: `${name} refused the sign-in (${error}).` };
}

function failureOf(provider: OAuthProvider, outcome: FetchOutcome): TokenResult {
  const refusal = refusalOf(outcome);
  if (refusal !== undefined) return refusalMessage(provider, refusal.error, refusal.description);
  const name = provider === 'google' ? 'Google' : 'Microsoft';
  if (outcome.status === 'failed' && outcome.code === 'http-error') {
    return { ok: false, reason: 'refused', message: `${name} refused the sign-in (${outcome.httpStatus ?? 0}).` };
  }
  return { ok: false, reason: 'unreachable', message: `Could not reach ${name} to sign in. It will be tried again.` };
}

/** A new access token from a stored refresh token — what every sync does first. */
export async function refreshAccessToken(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  account: {
    readonly provider: OAuthProvider;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly tenant?: string;
    readonly refreshToken: string;
  },
): Promise<TokenResult> {
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: account.clientId,
    refresh_token: account.refreshToken,
  };
  if (account.provider === 'google' && account.clientSecret !== undefined) form['client_secret'] = account.clientSecret;
  if (account.provider === 'microsoft') form['scope'] = MICROSOFT_SCOPES;
  const target: Target =
    account.provider === 'google'
      ? { kind: 'google-token' }
      : { kind: 'microsoft-token', tenant: account.tenant ?? 'common' };
  const outcome = await postForm(fetcher, endpoints, target, form);
  if (outcome.status !== 'ok') return failureOf(account.provider, outcome);
  const tokens = tokensFrom(outcome.body);
  return tokens === undefined
    ? { ok: false, reason: 'refused', message: 'The sign-in answer could not be read. It will be tried again.' }
    : { ok: true, ...tokens };
}

/** Google: the code its consent page sent back, exchanged with the PKCE verifier that asked for it. */
export async function exchangeGoogleCode(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  request: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
  },
): Promise<TokenResult> {
  const outcome = await postForm(fetcher, endpoints, { kind: 'google-token' }, {
    grant_type: 'authorization_code',
    client_id: request.clientId,
    client_secret: request.clientSecret,
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
  });
  if (outcome.status !== 'ok') return failureOf('google', outcome);
  const tokens = tokensFrom(outcome.body);
  if (tokens === undefined || tokens.refreshToken === undefined) {
    return {
      ok: false,
      reason: 'refused',
      message:
        'Google signed in but gave no lasting permission. Remove Maverick Wall from your Google ' +
        'account’s third-party access, then sign in again.',
    };
  }
  return { ok: true, ...tokens };
}

/** Google's consent page, for the household's browser. Nothing is sent from here. */
export function googleConsentUrl(
  endpoints: OAuthEndpoints,
  request: { readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly challenge: string },
): string {
  const params = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    // A refresh token, and asked for every time: Google sends one only on a
    // consent the user has just given, so a second sign-in without this would
    // come back with nothing to keep.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
  });
  return `${endpoints.googleAuth}?${params.toString()}`;
}

const deviceCodeShape = z.object({
  device_code: z.string().min(1).max(4000),
  user_code: z.string().min(1).max(40),
  verification_uri: z.string().url().max(400),
  expires_in: z.coerce.number().int().positive().max(3600).catch(900),
  interval: z.coerce.number().int().positive().max(60).catch(5),
});

export type DeviceCodeResult =
  | {
      readonly ok: true;
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSec: number;
      readonly intervalSec: number;
    }
  | { readonly ok: false; readonly message: string };

/** Microsoft: a code for the household to type at microsoft.com/devicelogin. */
export async function startMicrosoftDeviceCode(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  request: { readonly clientId: string; readonly tenant: string },
): Promise<DeviceCodeResult> {
  const outcome = await postForm(
    fetcher,
    endpoints,
    { kind: 'microsoft-devicecode', tenant: request.tenant },
    { client_id: request.clientId, scope: MICROSOFT_SCOPES },
  );
  if (outcome.status !== 'ok') {
    const failed = failureOf('microsoft', outcome);
    return { ok: false, message: failed.ok ? '' : failed.message };
  }
  const parsed = deviceCodeShape.safeParse(parseJsonOr(z.unknown(), outcome.body, undefined));
  if (!parsed.success) return { ok: false, message: 'Microsoft answered, but not with a sign-in code.' };
  // The code is shown to the household and the address is a link on the page,
  // so the address is held to Microsoft's own before it is drawn.
  const verification = new URL(parsed.data.verification_uri);
  if (verification.protocol !== 'https:') {
    return { ok: false, message: 'Microsoft answered with a sign-in address that is not secure.' };
  }
  return {
    ok: true,
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    expiresInSec: parsed.data.expires_in,
    intervalSec: parsed.data.interval,
  };
}

export type PollResult =
  | { readonly state: 'pending' }
  | { readonly state: 'slow-down' }
  | { readonly state: 'declined' }
  | { readonly state: 'expired' }
  | ({ readonly state: 'ok' } & Tokens)
  | { readonly state: 'failed'; readonly message: string };

/** Has the household finished signing in at microsoft.com/devicelogin? Asked once per press. */
export async function pollMicrosoftDeviceCode(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  request: { readonly clientId: string; readonly tenant: string; readonly deviceCode: string },
): Promise<PollResult> {
  const outcome = await postForm(
    fetcher,
    endpoints,
    { kind: 'microsoft-token', tenant: request.tenant },
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: request.clientId,
      device_code: request.deviceCode,
    },
  );
  if (outcome.status === 'ok') {
    const tokens = tokensFrom(outcome.body);
    if (tokens === undefined || tokens.refreshToken === undefined) {
      return { state: 'failed', message: 'Microsoft signed in but gave no lasting permission. Try again.' };
    }
    return { state: 'ok', ...tokens };
  }
  const refusal = refusalOf(outcome);
  switch (refusal?.error) {
    case 'authorization_pending':
      return { state: 'pending' };
    case 'slow_down':
      return { state: 'slow-down' };
    case 'authorization_declined':
    case 'access_denied':
      return { state: 'declined' };
    case 'expired_token':
    case 'code_expired':
    case 'bad_verification_code':
      return { state: 'expired' };
  }
  const failed = failureOf('microsoft', outcome);
  return { state: 'failed', message: failed.ok ? '' : failed.message };
}
