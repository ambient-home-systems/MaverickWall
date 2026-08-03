import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SqliteDatabase } from '../db/open.js';
import type { SessionResolver, SessionUser } from './session.js';
import * as schema from '../db/schema.js';

/**
 * The Better Auth adapter.
 *
 * Deliberately the only file in the application that names the library. Every
 * decision about who may do what lives in session.ts behind a `SessionResolver`,
 * so this stays down to configuration and one function.
 *
 * That split exists because this code was written somewhere the library could
 * not be installed, and an auth layer is the worst possible place to be wrong
 * about an API. Keeping the untestable surface to a single adapter means a
 * mistake here is one file to correct rather than a rewrite.
 */

/**
 * The header this server puts the real client address in.
 *
 * Better Auth reads the client IP from headers only — it never sees the
 * socket — and rate limiting is keyed on it. With no such header every caller
 * shares a single bucket, so one screen polling too eagerly can lock the whole
 * household out of signing in. Verified, not assumed: with this unset, three
 * sign-up attempts from independent instances were enough to return 429.
 *
 * Deliberately a private name rather than `x-forwarded-for`. The value is
 * overwritten from the socket on every request, so nothing a client sends is
 * ever read, and a name nothing else uses makes that impossible to confuse
 * with a proxy header somebody meant to trust.
 */
export const CLIENT_IP_HEADER = 'x-mw-client-ip';

export interface AuthOptions {
  readonly db: SqliteDatabase;
  /** Signing key, derived from the master key so it survives restarts. */
  readonly secret: string;
  /**
   * The origin the browser sees.
   *
   * Under a Home Assistant add-on this is not the port we bound: ingress serves
   * the app under a path that differs per installation, and cookies scoped to
   * the wrong path silently fail to come back.
   */
  readonly baseUrl: string;
  readonly basePath?: string;
}

export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(drizzle(options.db, { schema }), {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    secret: options.secret,
    baseURL: options.baseUrl,
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),

    /**
     * Trust the address the browser actually used to get here.
     *
     * `baseUrl` cannot know it. A household reaches a self-hosted box by LAN
     * IP, by mDNS name, by hostname, or by localhost, and whichever one they
     * type is the origin their browser stamps on every form post. With only
     * `baseUrl` trusted, browsing to `http://192.168.1.10:8080` and signing up
     * fails with "Missing or null Origin" — which is not a sentence anybody
     * standing in a kitchen can act on.
     *
     * This is still same-origin only, and so still a real CSRF check: a form
     * on another site posting here carries *its* origin, which matches neither
     * entry. What it permits is exactly the case where the request came back
     * to the host it was served from.
     */
    trustedOrigins: (request?: Request) => {
      const origins = [options.baseUrl];
      if (request !== undefined) {
        try {
          origins.push(new URL(request.url).origin);
        } catch {
          // A URL we cannot parse is one we cannot trust. Leave the list as is.
        }
      }
      return origins;
    },

    emailAndPassword: {
      enabled: true,
      // No email is ever sent. There is no mail server in a self-hosted
      // container, and a verification link nobody can receive would lock the
      // household out of their own wall.
      requireEmailVerification: false,
      minPasswordLength: 10,
      autoSignIn: true,
    },

    session: {
      // Long, because signing in again on a tablet mounted to a wall is
      // genuinely difficult, and this is a household LAN rather than a bank.
      expiresIn: 60 * 60 * 24 * 90,
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      // Rule ten. Somebody will expose this to the internet, and these cost
      // nothing on a LAN.
      useSecureCookies: options.baseUrl.startsWith('https://'),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },
      ipAddress: {
        // Only this one, and only because the server sets it from the socket.
        // Leaving `x-forwarded-for` in the list would let any client on the
        // LAN pick its own rate-limit bucket by sending the header.
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Bridge Better Auth to the interface the rest of the application uses.
 *
 * Never throws: a broken session store should read as "not signed in" rather
 * than take down every request behind it.
 */
export function createSessionResolver(auth: Auth): SessionResolver {
  return {
    async resolve(request: Request): Promise<SessionUser | undefined> {
      try {
        const session = await auth.api.getSession({ headers: request.headers as never });
        if (!session?.user) return undefined;
        return {
          id: String(session.user.id),
          email: String(session.user.email),
          name: String(session.user.name ?? session.user.email),
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Work out the origin the browser is actually using.
 *
 * Under Home Assistant ingress the app is served from a path that changes per
 * installation, and the supervisor forwards it in a header. Getting this wrong
 * produces the worst kind of bug: sign-in appears to succeed, the cookie is set
 * for the wrong path, and every subsequent request is anonymous with no error
 * anywhere.
 *
 * Only headers set by the supervisor are trusted, and only when the request
 * arrived through it. A forwarded header on the public port is somebody
 * probing.
 */
export function resolveBaseUrl(
  headers: { get(name: string): string | null },
  fallback: string,
  trustProxyHeaders: boolean,
): { baseUrl: string; basePath?: string } {
  if (!trustProxyHeaders) return { baseUrl: fallback };

  const ingressPath = headers.get('x-ingress-path');
  const forwardedHost = headers.get('x-forwarded-host');
  const forwardedProto = headers.get('x-forwarded-proto') ?? 'http';

  if (forwardedHost === null) return { baseUrl: fallback };

  const origin = `${forwardedProto}://${forwardedHost}`;
  return ingressPath === null || ingressPath === ''
    ? { baseUrl: origin }
    : { baseUrl: origin, basePath: `${ingressPath}/api/auth` };
}
