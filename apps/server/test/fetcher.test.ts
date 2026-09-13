import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { validateOutboundUrl, type UrlPolicy } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';
import { testFeed } from '../src/api/test-feed.js';

/**
 * The fetcher against a real HTTP server.
 *
 * Redirect chains, streamed size caps and timeouts cannot be proven with a
 * stub: they are properties of how the socket behaves, not of the code's
 * shape. So this stands up a server, points the fetcher at it, and makes it
 * misbehave in the specific ways real feeds do.
 */

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

/** Loopback is refused by default, so tests opt in the same way an operator would. */
const LOOPBACK: UrlPolicy = { allowLoopback: true, allowHttp: true };

let server: Server;
let base: string;
const fetcher = createFetcher();

interface Reply {
  writeHead(status: number, headers?: Record<string, string>): void;
  write(chunk: string): void;
  end(body?: string): void;
  /** Same as end, typed for binary payloads. */
  endBuffer(body: Buffer): void;
}
interface Ask {
  headers: Record<string, string | string[] | undefined>;
  /** Present on every real request. The GET routes never look. */
  method?: string;
  url?: string;
  on(event: 'data' | 'end', listener: (chunk: Buffer) => void): void;
}
const routes: Record<string, (req: Ask, res: Reply) => void> = {};

/**
 * Every request this server was actually asked for.
 *
 * The refusals below are claims about packets that were *not* sent — a
 * redirect that was not followed, an address that was refused before the
 * socket — and an outcome alone cannot tell "refused" from "the server
 * answered that way". This is the other half of each of those assertions.
 */
const asked: { method: string; path: string }[] = [];

function readBody(req: Ask, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    asked.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0] ?? '' });
    const handler = routes[(req.url ?? '').split('?')[0] ?? ''];
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const reply = res as unknown as Reply;
    reply.endBuffer = reply.end as unknown as (body: Buffer) => void;
    handler(req as unknown as Ask, reply);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

function get(path: string, extra: Record<string, unknown> = {}) {
  return fetcher.fetch({
    url: `${base}${path}`,
    policy: LOOPBACK,
    maxBytes: 1024 * 1024,
    timeoutMs: 2000,
    ...extra,
  });
}

routes['/cal.ics'] = (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    etag: '"abc"',
    'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
  });
  res.end(ICS);
};

routes['/conditional'] = (req, res) => {
  if (req.headers['if-none-match'] === '"abc"') {
    res.writeHead(304, { etag: '"abc"' });
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(ICS);
  }
};

routes['/html'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html>404 page</html>');
};

routes['/huge'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar' });
  const chunk = 'x'.repeat(64 * 1024);
  let sent = 0;
  const timer = setInterval(() => {
    if (sent++ > 200) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(chunk);
  }, 1);
};

routes['/slow'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar' });
  setTimeout(() => res.end(ICS), 5000);
};

routes['/500'] = (_req, res) => {
  res.writeHead(500);
  res.end('boom');
};

routes['/429'] = (_req, res) => {
  res.writeHead(429, { 'retry-after': '120' });
  res.end('slow down');
};

routes['/r1'] = (_req, res) => {
  res.writeHead(302, { location: '/cal.ics' });
  res.end();
};

routes['/loop'] = (_req, res) => {
  res.writeHead(302, { location: '/loop' });
  res.end();
};

routes['/to-metadata'] = (_req, res) => {
  res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
  res.end();
};

routes['/to-lan'] = (_req, res) => {
  res.writeHead(302, { location: 'http://192.168.1.50/secret' });
  res.end();
};

routes['/gzip'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
  res.endBuffer(gzipSync(Buffer.from(ICS, 'utf8')));
};

routes['/deflate'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'deflate' });
  res.endBuffer(deflateSync(Buffer.from(ICS, 'utf8')));
};

routes['/br'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'br' });
  res.endBuffer(brotliCompressSync(Buffer.from(ICS, 'utf8')));
};

routes['/lying-encoding'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
  res.end(ICS);
};

routes['/bomb'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
  res.endBuffer(gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x41)));
};

routes['/echo'] = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.headers));
};

/** Hands back what it was sent, so the request can be asserted from outside. */
routes['/post-echo'] = (req, res) => {
  readBody(req, (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        contentType: req.headers['content-type'],
        accept: req.headers['accept'],
        contentLength: req.headers['content-length'],
        authorization: req.headers['authorization'],
        body,
      }),
    );
  });
};

routes['/post-redirect'] = (_req, res) => {
  res.writeHead(302, { location: '/post-landing' });
  res.end();
};

/** Must never be reached. `asked` is what proves it. */
routes['/post-landing'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"reached":true}');
};

/** Home Assistant's own shape for a service call it will not make. */
routes['/post-refused'] = (_req, res) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(
    '{"message":"Service call requires responses but caller did not ask for responses"}',
  );
};

routes['/post-huge'] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(`{"pad":"${'A'.repeat(200_000)}"}`);
};

describe('the policy model', () => {
  // The distinction that matters: enabling LAN access must never open the
  // loopback interface, and neither flag may ever open link-local, because
  // 169.254.169.254 is the cloud metadata endpoint.
  it.each([
    ['default', {}],
    ['LAN opt-in', { allowPrivateNetwork: true, allowHttp: true }],
    ['loopback opt-in', { allowLoopback: true, allowHttp: true }],
    ['both', { allowPrivateNetwork: true, allowLoopback: true, allowHttp: true }],
  ] as [string, UrlPolicy][])('refuses the metadata endpoint under %s', (_label, policy) => {
    expect(validateOutboundUrl('http://169.254.169.254/latest/meta-data/', policy).ok).toBe(false);
    expect(validateOutboundUrl('http://[fe80::1]/', policy).ok).toBe(false);
  });

  it('keeps loopback and LAN as separate decisions', () => {
    const lan: UrlPolicy = { allowPrivateNetwork: true, allowHttp: true };
    const loop: UrlPolicy = { allowLoopback: true, allowHttp: true };
    expect(validateOutboundUrl('http://127.0.0.1/', lan).ok).toBe(false);
    expect(validateOutboundUrl('http://127.0.0.1/', loop).ok).toBe(true);
    expect(validateOutboundUrl('http://192.168.1.5/', loop).ok).toBe(false);
    expect(validateOutboundUrl('http://192.168.1.5/', lan).ok).toBe(true);
  });
});

describe('a well-behaved feed', () => {
  it('returns the body with its caching headers', async () => {
    const result = await get('/cal.ics', { acceptContentTypes: ['text/calendar'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.body).toBe(ICS);
    expect(result.contentType).toBe('text/calendar');
    expect(result.etag).toBe('"abc"');
    expect(result.lastModified).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
    expect(result.byteSize).toBe(Buffer.byteLength(ICS));
  });

  it('identifies itself and forwards custom headers', async () => {
    const result = await get('/echo', { headers: { 'X-Custom': 'yes' } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const sent = JSON.parse(result.body) as Record<string, string>;
    expect(sent['user-agent']?.startsWith('MaverickWall/')).toBe(true);
    expect(sent['x-custom']).toBe('yes');
  });
});

describe('conditional requests', () => {
  it('recognises 304 so an unchanged feed costs almost nothing', async () => {
    const result = await get('/conditional', { conditional: { etag: '"abc"' } });
    expect(result.status).toBe('not-modified');
  });

  it('fetches normally without the header', async () => {
    expect((await get('/conditional')).status).toBe('ok');
  });
});

describe('misbehaving servers', () => {
  it('rejects an HTML error page by content type', async () => {
    // A dead feed URL answers with an HTML page far more often than it 404s.
    // Checking the type turns a confusing parse failure into a clear message.
    const result = await get('/html', { acceptContentTypes: ['text/calendar'] });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.code).toBe('unacceptable-content-type');
  });

  it('stops a response that keeps growing', async () => {
    // Enforced while streaming. Content-Length is a claim, not a promise, and
    // a hostile server can simply keep sending.
    const result = await fetcher.fetch({
      url: `${base}/huge`,
      policy: LOOPBACK,
      maxBytes: 256 * 1024,
      timeoutMs: 4000,
    });
    expect(result.status === 'failed' && result.code).toBe('too-large');
  });

  it('gives up on a server that never answers', async () => {
    const result = await fetcher.fetch({
      url: `${base}/slow`,
      policy: LOOPBACK,
      maxBytes: 1024,
      timeoutMs: 300,
    });
    expect(result.status === 'failed' && result.code).toBe('timeout');
  });

  it('reports an HTTP error with its status', async () => {
    const result = await get('/500');
    expect(result.status === 'failed' && result.httpStatus).toBe(500);
  });

  it('honours Retry-After so backoff respects the upstream', async () => {
    const result = await get('/429');
    expect(result.status === 'failed' && result.retryAfterSeconds).toBe(120);
  });

  it('turns a refused connection into a sentence, not an errno', async () => {
    // A port with nothing listening: bind one, note it, close it. Node would
    // report `connect ECONNREFUSED 127.0.0.1:<port>` — a diagnosis for us and
    // noise on a settings page, and exactly what the wizard's calendar step
    // used to show.
    const probe = createTcpServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await fetcher.fetch({
      url: `http://127.0.0.1:${port}/cal.ics`,
      policy: LOOPBACK,
      maxBytes: 1024,
      timeoutMs: 4000,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.code).toBe('network-error');
    const message = result.status === 'failed' ? result.message : '';
    expect(message).toContain('refused');
    expect(message).not.toContain('ECONNREFUSED');
    // Never the socket address either — the message is prose, not a dump.
    expect(message).not.toContain('127.0.0.1');
  });

  it('turns a cut-off connection into a sentence, not an errno', async () => {
    // A server that accepts and immediately destroys the socket.
    const rude = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => rude.listen(0, '127.0.0.1', resolve));
    const address = rude.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const result = await fetcher.fetch({
        url: `http://127.0.0.1:${port}/cal.ics`,
        policy: LOOPBACK,
        maxBytes: 1024,
        timeoutMs: 4000,
      });
      expect(result.status === 'failed' && result.code).toBe('network-error');
      const message = result.status === 'failed' ? result.message : '';
      expect(message).toContain('cut off');
      expect(message).not.toContain('ECONNRESET');
    } finally {
      await new Promise<void>((resolve) => rude.close(() => resolve()));
    }
  });
});

describe('testFeed against a dead address', () => {
  it('answers with advice a household can act on', async () => {
    // The end-to-end path the wizard's calendar step takes: the fetcher's
    // sentence as the message, and a suggestion beside it.
    const probe = createTcpServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await testFeed(
      {
        url: `http://127.0.0.1:${port}/cal.ics`,
        allowLoopback: true,
        allowHttp: true,
        timezone: 'Europe/London',
      },
      fetcher,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('fetch');
      expect(result.message).toContain('refused');
      expect(result.message).not.toContain('ECONNREFUSED');
      expect(result.suggestion).toContain('running');
    }
  });
});

describe('redirects', () => {
  it('follows one and reports the final URL', async () => {
    const result = await get('/r1', { acceptContentTypes: ['text/calendar'] });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.finalUrl.endsWith('/cal.ics')).toBe(true);
  });

  it('stops a redirect loop', async () => {
    expect((await get('/loop')).status === 'rejected').toBe(true);
  });

  it('revalidates the target, which is the bypass this closes', async () => {
    // The standard SSRF bypass: the first request goes somewhere harmless and
    // the 302 points at the metadata endpoint.
    const meta = await get('/to-metadata');
    expect(meta.status).toBe('rejected');
    expect(meta.status === 'rejected' && meta.code).toBe('redirect-rejected');
  });

  it('applies the same policy to the target as to the original', async () => {
    // This source opted into loopback only, so a redirect onto the LAN is
    // refused even though some other source might be allowed to go there.
    const lan = await get('/to-lan');
    expect(lan.status === 'rejected' && lan.code).toBe('redirect-rejected');
  });
});

describe('content encoding', () => {
  // The bug this pins: `accept-encoding` was announced but the response was
  // never decompressed. `toString('utf8')` on gzip bytes destroys them
  // irreversibly -- the magic number 1f 8b becomes 1f ef bf bd -- and it
  // surfaced as a Google Calendar feed that would not parse, with nothing to
  // indicate why.
  it.each(['/gzip', '/deflate', '/br'])('decodes %s back to the original', async (path) => {
    const result = await get(path, { acceptContentTypes: ['text/calendar'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.body).toBe(ICS);
    expect(result.byteSize).toBe(Buffer.byteLength(ICS, 'utf8'));
  });

  it('refuses a compression bomb rather than expanding it', async () => {
    // Capping only the compressed size would not help: the ratio is the attack.
    const result = await fetcher.fetch({
      url: `${base}/bomb`,
      policy: LOOPBACK,
      maxBytes: 1024 * 1024,
      timeoutMs: 4000,
    });
    expect(result.status === 'failed' && result.code).toBe('too-large');
  });

  it('reports a server that lies about its encoding', async () => {
    const result = await get('/lying-encoding');
    expect(result.status).toBe('failed');
  });
});

/**
 * `postJson`, the second entry point, against the same real server.
 *
 * This is the boundary RFC 012 opens, and the only genuinely security-relevant
 * engineering in it: a POST carries a body and a bearer token where a GET
 * carries neither. Everything here is a property of how the socket behaves
 * rather than of the code's shape, which is why it is driven against a listener
 * and not a stub — the two refusals in particular are claims about packets that
 * were never sent, and only a server that can say what it was asked for can
 * settle those.
 */
describe('postJson', () => {
  function post(path: string, body: unknown, extra: Record<string, unknown> = {}) {
    return fetcher.postJson({
      url: `${base}${path}`,
      policy: LOOPBACK,
      maxBytes: 1024 * 1024,
      timeoutMs: 2000,
      body,
      ...extra,
    });
  }

  it('sends the body as JSON, with the content type and length to match', async () => {
    const result = await post('/post-echo', { entity_id: 'todo.shopping', status: 'completed' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const seen = JSON.parse(result.body) as Record<string, string>;
    expect(seen['method']).toBe('POST');
    expect(seen['contentType']).toBe('application/json');
    // Asked for JSON back, too. `postJson` has no `acceptContentTypes`: this is
    // fixed, so a call site cannot quietly ask for something else.
    expect(seen['accept']).toBe('application/json');
    // The adapter serialises. A caller never hands over text, so the header and
    // the bytes cannot disagree.
    expect(JSON.parse(seen['body'] ?? '')).toEqual({
      entity_id: 'todo.shopping',
      status: 'completed',
    });
    expect(seen['contentLength']).toBe(String(Buffer.byteLength(seen['body'] ?? '', 'utf8')));
  });

  it('carries the caller’s headers, which is how the token gets there', async () => {
    const result = await post('/post-echo', {}, { headers: { authorization: 'Bearer abc' } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect((JSON.parse(result.body) as Record<string, string>)['authorization']).toBe('Bearer abc');
  });

  it('will not let a caller talk it out of JSON', async () => {
    /*
     * The fixed pair is fixed, and this is the assertion that says so.
     *
     * `headers` is spread *before* `accept` and `content-type`, which reads as
     * an ordering detail and is the whole of the property: the adapter
     * serialises the body as JSON whatever a caller would rather the header
     * said, so a caller that could move that header could make the bytes and
     * the declaration disagree. Reordering the two spreads passes every other
     * test in this file — measured — so without this one "fixed" is a comment.
     */
    const result = await post(
      '/post-echo',
      { entity_id: 'todo.shopping' },
      { headers: { 'content-type': 'text/plain', accept: 'text/html' } },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const seen = JSON.parse(result.body) as Record<string, string>;
    expect(seen['contentType']).toBe('application/json');
    expect(seen['accept']).toBe('application/json');
  });

  it('refuses a redirect outright, and never asks the second address', async () => {
    const before = asked.length;
    const result = await post('/post-redirect', { tick: true });

    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.code).toBe('redirect-rejected');

    /*
     * The half that matters. `fetch` would have followed this to
     * `/post-landing` and answered `ok`, so "it did not come back with the
     * landing page" proves nothing on its own — an outcome cannot tell a
     * refusal from a server that answered differently. What settles it is that
     * the second address was never requested at all: one hop, and the body and
     * the bearer token went nowhere but the address the guard approved.
     */
    const during = asked.slice(before);
    expect(during.map((a) => a.path)).toEqual(['/post-redirect']);
    expect(during.some((a) => a.path === '/post-landing')).toBe(false);
  });

  it('refuses a private-range destination before a packet is sent', async () => {
    // A literal the URL guard can see, so nothing is resolved and nothing is
    // dialled. `10.0.0.1` is a real routable-looking address on somebody's LAN.
    const result = await fetcher.postJson({
      url: 'http://10.0.0.1:8123/api/services/todo/update_item',
      policy: { allowHttp: true },
      maxBytes: 1024,
      timeoutMs: 2000,
      body: { entity_id: 'todo.shopping' },
    });
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.code).toBe('url-rejected');
  });

  it('refuses loopback under a policy that does not permit it, without connecting', async () => {
    // The stronger version of the case above: a server that really is listening
    // and really would answer, refused by policy. `asked` is the proof that the
    // refusal happened on this side rather than on the wire.
    const before = asked.length;
    const result = await post('/post-echo', { tick: true }, { policy: { allowHttp: true } });

    expect(result.status).toBe('rejected');
    expect(asked.length).toBe(before);
  });

  it('brings back the upstream’s own sentence on a 400', async () => {
    const result = await post('/post-refused', { entity_id: 'todo.shopping' });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.code).toBe('http-error');
    expect(result.httpStatus).toBe(400);

    /*
     * The whole reason `PostJsonOutcome` differs from `FetchOutcome` here. A
     * bare 400 is not a diagnosis; `{"message": "..."}` is, and this exact
     * sentence is the one that means our request was malformed rather than
     * their server being unwell. `fetch` throws a non-2xx body away by design.
     */
    expect(result.responseBody).toBeDefined();
    expect(JSON.parse(result.responseBody ?? '')).toEqual({
      message: 'Service call requires responses but caller did not ask for responses',
    });
  });

  it('still enforces the byte ceiling', async () => {
    const result = await post('/post-huge', {}, { maxBytes: 4096 });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.code).toBe('too-large');
  });

  it('reports a refused connection as a failure, not a throw', async () => {
    // The contract is that this never throws, the same as `fetch`.
    const result = await fetcher.postJson({
      url: 'http://127.0.0.1:1/api/services/todo/update_item',
      policy: LOOPBACK,
      maxBytes: 1024,
      timeoutMs: 2000,
      body: {},
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.code).toBe('network-error');
  });
});
