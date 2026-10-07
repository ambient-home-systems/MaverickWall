import type { UrlPolicy } from '@maverick-wall/core';

/**
 * Where Google and Microsoft are (plan item M5.11): the real addresses, or a
 * test's stand-in.
 *
 * Every address a calendar sign-in reaches is a constant here and never
 * anything a household typed, so every request goes through the SSRF-guarded
 * fetcher with the default policy — public https only. A test points the same
 * code at a loopback stand-in by handing over a different `OAuthEndpoints`,
 * which nothing in the product does.
 */
export interface OAuthEndpoints {
  /** Google's consent page, where the household's browser is sent. */
  readonly googleAuth: string;
  readonly googleToken: string;
  /** The Calendar API's base, `/calendar/v3` included. */
  readonly googleApi: string;
  /** Microsoft's sign-in service, before the tenant: `/{tenant}/oauth2/v2.0/…` follows. */
  readonly microsoftLogin: string;
  /** Microsoft Graph's base, `/v1.0` included. */
  readonly graph: string;
  readonly policy: UrlPolicy;
}

export const OAUTH: OAuthEndpoints = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleApi: 'https://www.googleapis.com/calendar/v3',
  microsoftLogin: 'https://login.microsoftonline.com',
  graph: 'https://graph.microsoft.com/v1.0',
  policy: {},
};

/**
 * What each provider is asked for, and nothing more.
 *
 * Google: read-only calendars, and `openid email` so the account can be named
 * on the Calendars screen. Microsoft: `Calendars.ReadBasic`, the least
 * privileged permission that reads events (it leaves out bodies, attachments
 * and attendees, none of which a wall draws), `offline_access` for a refresh
 * token, and `openid profile` for the account's name. Neither can write.
 */
export const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.readonly';
export const MICROSOFT_SCOPES = 'openid profile offline_access Calendars.ReadBasic';

export type OAuthProvider = 'google' | 'microsoft';

/** The host a provider's calendars come from, for `url_host` and diagnostics. */
export function apiHost(provider: OAuthProvider, endpoints: OAuthEndpoints): string {
  return new URL(provider === 'google' ? endpoints.googleApi : endpoints.graph).host;
}

/** A provider's name as a household reads it. */
export function providerName(provider: OAuthProvider): string {
  return provider === 'google' ? 'Google' : 'Microsoft 365';
}
