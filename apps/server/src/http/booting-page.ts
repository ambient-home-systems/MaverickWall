/**
 * The page and bodies served by the boot holder while the server is starting.
 *
 * A single-threaded server cannot answer a request during its own migrations —
 * better-sqlite3 runs them synchronously and the event loop is blocked — so the
 * port would refuse connections for the whole of a restart. A household pairing
 * a new screen in that window sees "can't connect", which reads as a broken
 * box rather than one that is seconds from ready. The holder is a *separate
 * process* the migrations never touch, so it can answer throughout: a clear,
 * self-refreshing page for a browser, a small 503 for a poller. Rule nine, one
 * level below the app: a clear message and a path back, never a refusal.
 *
 * Everything is a 503 with `Retry-After`, so the wall's poll, the supervisor's
 * health probe and Home Assistant ingress all treat it as the transient it is.
 * The page is self-contained — `/assets/*` is served by the holder too during
 * boot, so it could not fetch a stylesheet or font even if it wanted to.
 */

export const BOOTING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>Maverick Wall — booting</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0B0E11;color:#E9EEF4;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center;text-align:center;
    padding:24px;box-sizing:border-box}
  .card{max-width:34rem}
  .dot{width:16px;height:16px;border-radius:50%;background:#E8A33D;display:inline-block;
    animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
  h1{font-size:1.6rem;font-weight:700;letter-spacing:.02em;margin:20px 0 10px}
  p{color:#7E8C9C;font-size:1.05rem;line-height:1.5;margin:0}
</style>
</head>
<body>
  <div class="card">
    <span class="dot" aria-hidden="true"></span>
    <h1>Maverick Wall server is booting</h1>
    <p>Your calendar will be back soon. This page refreshes on its own and will
    show the wall the moment the server is ready — no need to reload.</p>
  </div>
</body>
</html>
`;

/** The message the machine callers get, in one place so it reads the same. */
const BOOTING_MESSAGE = 'Maverick Wall server is booting. Calendar will be back soon.';

/**
 * The body to answer a request with while booting, chosen by path: a page for a
 * browser, JSON for a poll or API caller, plain text for the health probe. The
 * caller writes it with status 503 and a `Retry-After`.
 */
export function bootingBody(pathname: string): { contentType: string; body: string } {
  if (pathname === '/healthz') {
    return { contentType: 'text/plain; charset=utf-8', body: 'booting\n' };
  }
  if (pathname.startsWith('/d/') || pathname.startsWith('/api/')) {
    return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: 'booting', message: BOOTING_MESSAGE }),
    };
  }
  return { contentType: 'text/html; charset=utf-8', body: BOOTING_HTML };
}
