import { z } from 'zod';
import { FETCH_LIMITS, type Fetcher, type UrlPolicy } from '@maverick-wall/core';

/**
 * Asking the supervisor where this add-on actually lives.
 *
 * A wall screen reaches the add-on on a mapped host port at the box's LAN
 * address, and until now a household had to discover both by hand and type them
 * into `base_url` — a string with three ways to get it wrong and no feedback
 * when it was. But the supervisor already knows both: it did the port mapping,
 * and it can name the host. This asks.
 *
 * Read-only, like everything that touches Home Assistant here — these are GETs
 * of the add-on's own configuration and the host's network, never a write. It
 * runs once at boot, which is the right granularity: changing a port mapping in
 * Home Assistant restarts the add-on, so a fresh boot re-detects.
 *
 * Everything degrades to "unknown": a plain `docker run` has no supervisor at
 * all, and a supervisor that is slow or refuses simply leaves the household on
 * the same manual `base_url` they had before. Nothing here can make the boot
 * fail — rule nine.
 */

/** The supervisor's own API root. A constant, not anything a household typed. */
const SUPERVISOR_ROOT = 'http://supervisor';

/*
 * `supervisor` resolves to a private address on the network the supervisor put
 * this container on, and it speaks http — the same reasons the Home Assistant
 * client permits exactly this host. The SSRF guard still runs; this only tells
 * it that these fixed internal hops are expected. Loopback is permitted too:
 * these are constant endpoints, never a URL a household supplied, so the guard's
 * real job — refusing user-pointed SSRF — is untouched, and it lets a test drive
 * a real local server rather than a stub.
 */
const POLICY: UrlPolicy = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true };

export type Env = Readonly<Record<string, string | undefined>>;

export interface WallAddressDetection {
  /**
   * The host port `<containerPort>/tcp` was mapped to:
   *   - a number — mapped, and this is where a screen connects;
   *   - `null`   — the add-on is present but the port is turned off;
   *   - `undefined` — not an add-on, or the supervisor could not be reached.
   */
  readonly mappedPort: number | null | undefined;
  /** The box's LAN host, no scheme or port, or undefined if it could not be found. */
  readonly host: string | undefined;
  /** A full `http://host:port` when both are known, else undefined. */
  readonly baseUrl: string | undefined;
}

async function fetchJson(
  fetcher: Fetcher,
  root: string,
  token: string,
  path: string,
): Promise<unknown> {
  const outcome = await fetcher.fetch({
    url: `${root}${path}`,
    policy: POLICY,
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 5000,
    headers: { authorization: `Bearer ${token}` },
  });
  if (outcome.status !== 'ok') return undefined;
  try {
    return JSON.parse(outcome.body);
  } catch {
    return undefined;
  }
}

/** `GET /addons/self/info` — the add-on's own config, including its port map. */
const AddonInfo = z.object({
  data: z.object({
    // Container "port/proto" -> host port, or null when the port is unmapped.
    network: z.record(z.string(), z.number().nullable()).nullish(),
  }),
});

/** `GET /core/api/config` — Home Assistant's own base URL, if the household set one. */
const CoreConfig = z.object({ internal_url: z.string().nullish() });

/** `GET /network/info` — the host's interfaces, for the LAN address. */
const NetworkInfo = z.object({
  data: z.object({
    interfaces: z
      .array(
        z.object({
          primary: z.boolean().optional(),
          ipv4: z.object({ address: z.array(z.string()).optional() }).nullish(),
        }),
      )
      .optional(),
  }),
});

/** The hostname out of a URL, or undefined if it is not a URL. */
function hostOf(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    const host = new URL(url).hostname;
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * The box's LAN address, best effort.
 *
 * Home Assistant's own `internal_url` is the best answer when the household set
 * one — it is by definition the address they reach this machine on. Most do
 * not, so the fallback is the primary network interface's first IPv4, which is
 * the LAN address in all but multi-homed setups. Either way the result is shown
 * back on the Screens page for a person to confirm or correct, so a wrong guess
 * costs an edit, never a silent dead link.
 */
async function detectHost(fetcher: Fetcher, root: string, token: string): Promise<string | undefined> {
  const config = CoreConfig.safeParse(await fetchJson(fetcher, root, token, '/core/api/config'));
  if (config.success) {
    const host = hostOf(config.data.internal_url);
    if (host !== undefined) return host;
  }

  const network = NetworkInfo.safeParse(await fetchJson(fetcher, root, token, '/network/info'));
  if (network.success) {
    const interfaces = network.data.data.interfaces ?? [];
    const primary = interfaces.find((iface) => iface.primary) ?? interfaces[0];
    const address = primary?.ipv4?.address?.[0];
    if (address !== undefined) {
      // Addresses come as CIDR (`192.168.1.33/24`); the wall wants the host.
      const bare = address.split('/')[0];
      if (bare !== undefined && bare !== '') return bare;
    }
  }
  return undefined;
}

/**
 * Where the wall should be told to connect, discovered from the supervisor.
 *
 * `containerPort` is what the app listens on inside the container (`PORT`,
 * 8080), which is the key the port map is stored under — not the host port,
 * which is exactly the thing being looked up.
 */
export async function detectWallAddress(
  fetcher: Fetcher,
  env: Env,
  containerPort: number,
  root: string = SUPERVISOR_ROOT,
): Promise<WallAddressDetection> {
  const token = env['SUPERVISOR_TOKEN'];
  if (typeof token !== 'string' || token === '') {
    return { mappedPort: undefined, host: undefined, baseUrl: undefined };
  }

  const info = AddonInfo.safeParse(await fetchJson(fetcher, root, token, '/addons/self/info'));
  // Present but unreadable is treated as unknown, not as unmapped: a null port
  // is a claim the supervisor made, and we should not invent it.
  const mappedPort = info.success ? (info.data.data.network?.[`${containerPort}/tcp`] ?? null) : undefined;

  // No point naming a host for a port nobody can reach.
  const host = typeof mappedPort === 'number' ? await detectHost(fetcher, root, token) : undefined;

  const baseUrl =
    typeof mappedPort === 'number' && host !== undefined ? `http://${host}:${mappedPort}` : undefined;

  return { mappedPort, host, baseUrl };
}
