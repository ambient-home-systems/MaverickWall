/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 *
 * Better Auth could not be installed where this was written, so this describes
 * the surface the adapter uses and nothing else. It is a statement of intent
 * rather than a record of the real API, and the first run against the installed
 * library is the thing that verifies it.
 */
declare module 'better-auth' {
  export interface BetterAuthOptions {
    database: unknown;
    secret: string;
    baseURL: string;
    basePath?: string;
    emailAndPassword?: {
      enabled: boolean;
      requireEmailVerification?: boolean;
      minPasswordLength?: number;
      autoSignIn?: boolean;
    };
    session?: { expiresIn?: number; updateAge?: number };
    advanced?: {
      useSecureCookies?: boolean;
      defaultCookieAttributes?: { httpOnly?: boolean; sameSite?: string };
    };
    rateLimit?: { enabled?: boolean; window?: number; max?: number };
  }

  export interface AuthInstance {
    api: {
      getSession(input: { headers: Headers }): Promise<
        { user?: { id: string; email: string; name?: string } } | null
      >;
    };
    handler(request: Request): Promise<Response>;
  }

  export function betterAuth(options: BetterAuthOptions): AuthInstance;
}

declare module 'better-auth/adapters/drizzle' {
  export function drizzleAdapter(
    db: unknown,
    config: { provider: string; schema?: Record<string, unknown> },
  ): unknown;
}

declare class Headers {
  get(name: string): string | null;
}
