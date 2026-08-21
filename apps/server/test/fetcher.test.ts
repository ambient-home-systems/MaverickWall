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
}
const routes: Record<string, (req: Ask, res: Reply) => void> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
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
