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
