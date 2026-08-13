/**
 * The boot holder: a tiny standalone server that owns the port and answers a
 * "booting" page while the real server runs its migrations and setup.
 *
 * `main.ts` spawns this as a child at the very start of boot and kills it just
 * before it binds the port itself, so the real server owns the socket directly
 * in steady state — nothing proxies once boot is done. It exists only because a
 * single process cannot serve during its own synchronous migrations; a separate
 * process can. See `http/booting-page.ts` for why this is a 503, not a 200.
 *
 * Deliberately dependency-free (plain `node:http`, no Hono) so it starts in
 * milliseconds — every millisecond here is a millisecond the port is still
 * refusing connections before the holder is up.
 */
import { createServer } from 'node:http';
import { bootingBody } from './http/booting-page.js';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? '8080');

const server = createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    // A malformed request-target: fall through to the generic page.
  }
  const { contentType, body } = bootingBody(pathname);
  res.writeHead(503, {
    'content-type': contentType,
    'retry-after': '3',
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  // The port is already taken — a leftover instance, or the real server bound
  // first. Nothing to hold, so step aside quietly and let the real server own
  // the port and report any genuine conflict itself.
  console.error(`[boot-holder] not holding ${port}: ${error.message}`);
  process.exit(0);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[boot-holder] holding ${port} until the server is ready`);
});

// The parent kills this the instant it is ready to bind. Close and exit fast so
// the socket is free by the time the parent's `exit` handler fires; the OS
// releases the listening socket on exit regardless, so the fallback timer only
// guards against a connection that refuses to drain.
const bye = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
