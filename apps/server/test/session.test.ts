import { describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import {
  currentUser,
  refuseLateSignUp,
  requireSession,
  requireSetupComplete,
  type SessionUser,
  type SetupState,
} from '../src/auth/session.js';

/**
 * Route gating, with the session store stubbed.
 *
 * Everything that decides who gets in is here and testable; the adapter that
 * actually validates a cookie is one file and depends on a library. Splitting
 * it that way means the rules are verified even though the library is not.
 */

const ALICE: SessionUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

function harness(options: { user?: SessionUser; setup?: Partial<SetupState> } = {}) {
  const deps = {
    sessions: {
      resolve: async () => options.user,
    },
    setupState: (): SetupState => ({
      hasUsers: options.setup?.hasUsers ?? true,
      complete: options.setup?.complete ?? true,
    }),
  };

  const app = new Hono();
  app.use('*', requireSetupComplete(deps));
  app.get('/healthz', (c: Context) => c.json({ ok: true }));
  app.get('/d/manifest', (c: Context) => c.json({ days: [] }));
  app.get('/setup', (c: Context) => c.text('wizard'));
  // Mounted where Better Auth puts it, and exempt from the setup gate.
  app.post('/api/auth/sign-up', refuseLateSignUp(deps), (c: Context) => c.json({ created: true }));
  app.use('/api/*', requireSession(deps));
  // Both, because `/admin/*` does not match `/admin` itself and protecting the
  // sub-pages while leaving the index open would be worse than useless.
  app.use('/admin', requireSession(deps));
  app.use('/admin/*', requireSession(deps));
  app.get('/api/calendars', (c: Context) => c.json({ who: currentUser(c).email }));
  app.get('/admin', (c: Context) => c.text('admin'));
  app.get('/api/broken', (c: Context) => c.json({ who: currentUser(c).email }));

  return {
    get: (path: string) => app.fetch(new Request(`http://localhost${path}`)),
    post: (path: string) => app.fetch(new Request(`http://localhost${path}`, { method: 'POST' })),
  };
}

describe('before setup is finished', () => {
  const incomplete = { setup: { complete: false, hasUsers: false } };

  it('sends a browser to the wizard', async () => {
    const response = await harness(incomplete).get('/admin');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/setup');
  });

  it('tells an API caller where to go, in a way it can act on', async () => {
    const response = await harness(incomplete).get('/api/calendars');
    expect(response.status).toBe(409);
    expect((await response.json() as Record<string, string>)['next']).toBe('/setup');
  });

  it('leaves the health check open', async () => {
    // Locking this out would make a stalled setup undiagnosable from outside.
    expect((await harness(incomplete).get('/healthz')).status).toBe(200);
  });

  it('leaves the display open', async () => {
    // A half-configured household is exactly when the wall most needs to say
    // something useful. Gating it would replace "not set up yet" with nothing.
    expect((await harness(incomplete).get('/d/manifest')).status).toBe(200);
  });

  it('lets the wizard itself through', async () => {
    expect((await harness(incomplete).get('/setup')).status).toBe(200);
  });

  it('leaves sign-up reachable, or setup can never be completed', async () => {
    // The deadlock this guards against: finishing setup needs an account,
    // creating one needs the sign-up endpoint, and the endpoint sat behind the
    // gate that finishing setup would open.
    expect((await harness(incomplete).post('/api/auth/sign-up')).status).toBe(200);
  });
});

describe('signing in', () => {
  it('redirects a signed-out browser to the form', async () => {
    const response = await harness().get('/admin');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in');
  });

  it('answers a signed-out API call with 401 rather than a redirect', async () => {
    // A fetch() following a redirect to an HTML page produces a confusing
    // parse error rather than a usable failure.
    const response = await harness().get('/api/calendars');
    expect(response.status).toBe(401);
    expect((await response.json() as Record<string, string>)['error']).toBe('unauthorized');
  });

  it('lets a signed-in user through and identifies them', async () => {
    const response = await harness({ user: ALICE }).get('/api/calendars');
    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, string>)['who']).toBe('alice@example.com');
  });

  it('treats a broken session store as signed out', async () => {
    // A resolver that throws is a broken store, not a rejected user, and
    // failing closed is the right reading either way.
    const app = new Hono();
    const deps = {
      sessions: {
        resolve: async (): Promise<SessionUser | undefined> => {
          throw new Error('session table is gone');
        },
      },
      setupState: (): SetupState => ({ hasUsers: true, complete: true }),
    };
    app.use('/api/*', requireSession(deps));
    app.get('/api/x', (c: Context) => c.json({ ok: true }));
    const response = await app.fetch(new Request('http://localhost/api/x'));
    expect(response.status).toBe(401);
  });
});

describe('sign-up is closed once an account exists', () => {
  // Rule ten: assume somebody exposes this to the internet badly. An open
  // registration endpoint would be a way in for anyone who can reach the port.
  it('refuses when a user already exists', async () => {
    const response = await harness({ setup: { hasUsers: true } }).post('/api/auth/sign-up');
    expect(response.status).toBe(403);
    expect((await response.json() as Record<string, string>)['error']).toBe('signup-closed');
  });

  it('permits the very first account', async () => {
    const response = await harness({ setup: { hasUsers: false, complete: false } }).post('/api/auth/sign-up');
    expect(response.status).toBe(200);
  });
});

describe('currentUser', () => {
  it('fails loudly on a route that forgot the middleware', async () => {
    // Serving somebody else's data quietly would be far worse than a 500.
    const app = new Hono();
    app.get('/api/broken', (c: Context) => c.json({ who: currentUser(c).email }));
    app.onError(() => new Response('boom', { status: 500 }));
    expect((await app.fetch(new Request('http://localhost/api/broken'))).status).toBe(500);
  });
});
