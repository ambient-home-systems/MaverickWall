import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFetcher } from '../src/net/fetcher.js';
import { detectWallAddress } from '../src/net/supervisor.js';

/**
 * Detecting the wall address off a *real* supervisor stand-in.
 *
 * A local HTTP server, not a stubbed fetcher: the thing most likely to be
 * silently wrong is whether the bearer token is attached and which paths are
 * asked for, and a fake that ignores the request would sail past both. This one
 * refuses without the token, exactly as the supervisor does.
 */

const TOKEN = 'super-secret-token';
const fetcher = createFetcher();

interface FakeSupervisor {
  readonly root: string;
  readonly paths: string[];
  network: Record<string, number | null> | null;
  internalUrl: string | null;
  interfaces: unknown;
  close(): Promise<void>;
}

async function fakeSupervisor(): Promise<FakeSupervisor> {
  const paths: string[] = [];
  const state = {
    network: { '8080/tcp': 8080 } as Record<string, number | null> | null,
    internalUrl: null as string | null,
    interfaces: [{ primary: true, ipv4: { address: ['192.168.1.33/24'] } }] as unknown,
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? '';
    paths.push(url);
    // Refuse without the token, like the supervisor does.
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"message":"Unauthorized"}');
      return;
    }
    const json = (body: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url === '/addons/self/info') return json({ result: 'ok', data: { network: state.network } });
    if (url === '/core/api/config') return json({ internal_url: state.internalUrl });
    if (url === '/network/info') return json({ result: 'ok', data: { interfaces: state.interfaces } });
    response.writeHead(404);
    response.end();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    root: `http://127.0.0.1:${port}`,
    paths,
    get network() {
      return state.network;
    },
    set network(value) {
      state.network = value;
    },
    get internalUrl() {
      return state.internalUrl;
    },
    set internalUrl(value) {
      state.internalUrl = value;
    },
    get interfaces() {
      return state.interfaces;
    },
    set interfaces(value) {
      state.interfaces = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let open: FakeSupervisor | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const env = { SUPERVISOR_TOKEN: TOKEN };

describe('detecting the wall address from the supervisor', () => {
  it('builds the base URL from the mapped port and Home Assistant’s own URL', async () => {
    open = await fakeSupervisor();
    open.internalUrl = 'http://192.168.1.50:8123'; // a household who set it

    const result = await detectWallAddress(fetcher, env, 8080, open.root);
    // The host comes from internal_url; the port is the *mapped* one, not 8123.
    expect(result.mappedPort).toBe(8080);
    expect(result.host).toBe('192.168.1.50');
    expect(result.baseUrl).toBe('http://192.168.1.50:8080');
    // It asked for its own info with the token attached (the fake refuses without).
    expect(open.paths).toContain('/addons/self/info');
  });

  it('falls back to the primary interface when Home Assistant has no URL set', async () => {
    open = await fakeSupervisor();
    open.internalUrl = null; // the common case

    const result = await detectWallAddress(fetcher, env, 8080, open.root);
    // CIDR is trimmed to the host; the mapped port is kept.
    expect(result.host).toBe('192.168.1.33');
    expect(result.baseUrl).toBe('http://192.168.1.33:8080');
    expect(open.paths).toContain('/network/info');
  });

  it('carries whatever host port the supervisor actually mapped', async () => {
    open = await fakeSupervisor();
    open.network = { '8080/tcp': 8090 }; // 8080 was taken; mapped elsewhere

    const result = await detectWallAddress(fetcher, env, 8080, open.root);
    expect(result.mappedPort).toBe(8090);
    expect(result.baseUrl).toBe('http://192.168.1.33:8090');
  });

  it('reports the port as off, distinctly from not knowing', async () => {
    open = await fakeSupervisor();
    open.network = { '8080/tcp': null }; // present, but disabled

    const result = await detectWallAddress(fetcher, env, 8080, open.root);
    expect(result.mappedPort).toBeNull();
    // No host or URL for a port nothing can reach — and the Screens page keys
    // its "turn the port on" message off exactly this null.
    expect(result.host).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
  });

  it('knows nothing, rather than guessing, with no supervisor token', async () => {
    open = await fakeSupervisor();
    const result = await detectWallAddress(fetcher, {}, 8080, open.root);
    expect(result).toEqual({ mappedPort: undefined, host: undefined, baseUrl: undefined });
    // It should not have called anything without a token to call with.
    expect(open.paths).toEqual([]);
  });

  it('degrades to unknown when the supervisor cannot be reached', async () => {
    open = await fakeSupervisor();
    const root = open.root;
    await open.close();
    open = undefined; // already closed; nothing is listening now

    const result = await detectWallAddress(fetcher, env, 8080, root);
    expect(result.mappedPort).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
  });
});
