import type { Context, Next } from 'hono';

/**
 * Who is asking, and are they allowed to.
 *
 * Deliberately structured around a `SessionResolver` interface rather than
 * calling Better Auth directly. Everything interesting here — which routes are
 * open, what happens before setup finishes, how a failure is reported — is then
 * testable with a stub, and the part that depends on a library this was written
 * without stays down to a single adapter.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface SessionResolver {
  /** The signed-in user, or undefined. Must never throw. */
  resolve(request: Request): Promise<SessionUser | undefined>;
}

export interface SetupState {
  /** Whether any account exists yet. */
  readonly hasUsers: boolean;
  /** Whether the first-run wizard has been completed. */
  readonly complete: boolean;
}

export interface GateDeps {
  readonly sessions: SessionResolver;
  readonly setupState: () => SetupState;
}

/**
 * Paths that answer regardless of setup or sign-in state.
 *
 * `/healthz` because a monitoring check that needs a credential is one nobody
 * configures. `/d/*` because a wall display carries its own token and must keep
 * rendering whatever it last knew — a half-configured household is exactly when
 * the screen most needs to say something useful rather than nothing.
 */
const ALWAYS_OPEN = [
  '/healthz',
  '/d/',
  '/pair',
  '/assets/',
  /*
   * The sign-in form, which lives under the prefix it lets you through.
   *
   * Without this the redirect points at a path this same gate protects, so an
   * anonymous browser is sent to `/admin/sign-in`, refused, and sent there
   * again — a loop that a route table makes look entirely reasonable.
   */
  '/admin/sign-in',
  /*
   * Authentication itself, which must work before setup can finish.
   *
   * Without this the gate deadlocks: completing setup requires an account,
   * creating an account requires the sign-up endpoint, and the endpoint is
   * behind the gate that setup would open. The first version had exactly that
   * shape and nothing but a test noticed.
   */
  '/api/auth/',
];

function isAlwaysOpen(path: string): boolean {
  return ALWAYS_OPEN.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * Require a signed-in user.
 *
 * Answers 401 with JSON for API paths and a redirect for page loads, because a
 * browser following a link should land on the sign-in form rather than reading
 * an error object.
 */
export function requireSession(deps: GateDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    /*
     * The exemption is a property of the path, not of registration order.
     *
     * Mounting this over `/api/*` catches `/api/auth/sign-up` too, so signing
     * up would require being signed in. Ordering the middleware around it does
     * work, but it makes the correctness of the whole auth layer depend on the
     * sequence of two lines that look independent — and the failure is a
     * locked-out household with no way back in.
     */
    if (isAlwaysOpen(c.req.path)) {
      await next();
      return;
    }

    let user: SessionUser | undefined;
    try {
      /*
       * The headers are the credential. Constructing a bodyless GET keeps a
       * resolver from consuming the real request's body, but it has to carry
       * the cookie across or every signed-in user resolves as anonymous —
       * which is what this did until a test drove a real cookie through it.
       */
      user = await deps.sessions.resolve(
        new Request(c.req.url, { method: 'GET', headers: c.req.raw.headers }),
      );
    } catch {
      // A resolver that throws is a broken session store, not a rejected user.
      // Treating it as "not signed in" is the safe reading either way.
      user = undefined;
    }

    if (!user) {
      return c.req.path.startsWith('/api/')
        ? c.json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401)
        : c.redirect('/admin/sign-in', 302);
    }

    c.set('user', user);
    await next();
  };
}

/**
 * Hold everything back until the first-run wizard has finished.
 *
 * The household asked for this outright, and it is the right default: a
 * half-configured wall is confusing in a way an obviously-unfinished one is
 * not. The exceptions above matter though — locking out the health check would
 * make a stalled setup undiagnosable, and locking out the display would replace
 * "not set up yet" with nothing at all.
 */
export function requireSetupComplete(deps: GateDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (isAlwaysOpen(c.req.path) || c.req.path.startsWith('/setup')) {
      await next();
      return;
    }

    const state = deps.setupState();
    if (state.complete) {
      await next();
      return;
    }

    return c.req.path.startsWith('/api/')
      ? c.json(
          {
            error: 'setup-incomplete',
            message: 'Finish setting up Maverick Wall before using this.',
            next: '/setup',
          },
          409,
        )
      : c.redirect('/setup', 302);
  };
}

/**
 * Refuse sign-up once an account exists.
 *
 * There is no public registration. The first account is created through the
 * wizard with a token printed to the container log; after that, an open
 * registration endpoint would be a way in for anyone who can reach the port —
 * and rule ten says to assume somebody will expose this badly.
 */
export function refuseLateSignUp(deps: GateDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (deps.setupState().hasUsers) {
      return c.json(
        {
          error: 'signup-closed',
          message: 'An account already exists. Maverick Wall does not allow public sign-up.',
        },
        403,
      );
    }
    await next();
  };
}

/**
 * Mount `requireSession` over a prefix and the prefix itself.
 *
 * `/admin/*` does not match `/admin`, so registering only the wildcard leaves
 * the index page open while protecting everything under it — a mistake that
 * looks correct in the route table and is invisible until somebody tries it.
 */
export function protectPrefix(
  app: { use(path: string, ...handlers: unknown[]): unknown },
  prefix: string,
  deps: GateDeps,
): void {
  const middleware = requireSession(deps);
  app.use(prefix, middleware);
  app.use(`${prefix}/*`, middleware);
}

/** The signed-in user, for a handler that ran behind `requireSession`. */
export function currentUser(c: Context): SessionUser {
  const user = c.get('user') as SessionUser | undefined;
  if (!user) {
    // A handler reaching this without the middleware is a wiring mistake, and a
    // loud failure beats a quiet one that serves somebody else's data.
    throw new Error('currentUser called on a route without requireSession');
  }
  return user;
}
