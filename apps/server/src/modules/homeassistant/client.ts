import { FETCH_LIMITS, validateOutboundUrl, type Fetcher, type NetworkOption, type UrlPolicy } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';

/**
 * The Home Assistant connection: two credential paths, one client.
 *
 * **Read-only, permanently.** Nothing in this file or anything that calls it
 * issues a POST to Home Assistant. There are no service calls, no toggles and
 * no switches, and that is a security property rather than a missing feature —
 * see the note on the token below.
 *
 * Path A is the add-on: the supervisor injects `SUPERVISOR_TOKEN` and proxies
 * Core at a fixed address, so a household who installed the add-on has already
 * finished configuring this. Path B is a separate Home Assistant reached with
 * a long-lived access token the household pastes in. After the connection is
 * resolved the two are the same code.
 *
 * ## The token
 *
 * A Home Assistant long-lived access token has **full control of the house**.
 * There are no scopes: the same token that reads a temperature can unlock a
 * door. That single fact decides most of the design here.
 *
 *   - It is stored as a keyring envelope, the same as a calendar address.
 *   - It never appears in a log, a diagnostics export, an error message or the
 *     manifest. The display receives resolved *values* — "19.4 °C" — and never
 *     an entity handle, never a proxy endpoint it could query with, and never
 *     the token itself.
 *   - Nothing writes. If a wall tablet in a hallway is compromised, the blast
 *     radius has to be "somebody saw my indoor temperature", not "somebody
 *     opened my garage".
 *
 * Everything returns a value. A Home Assistant that is down is a stale reading
 * and a note, never an exception into manifest assembly.
 */

/** Where the supervisor proxies Core. Fixed by the add-on contract. */
export const SUPERVISOR_BASE = 'http://supervisor/core/api';

export type ConnectionMode = 'supervisor' | 'manual';

export interface Connection {
  readonly mode: ConnectionMode;
  /** No trailing slash. Paths are appended with a leading slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly policy: UrlPolicy;
  /** Host only, for the admin screen and diagnostics. Never the token. */
  readonly host: string;
}

export type ConnectionResult =
  | { readonly ok: true; readonly connection: Connection }
  | {
      readonly ok: false;
      readonly code: 'not-configured' | 'key-lost' | 'bad-address';
      readonly message: string;
      readonly suggestion?: string;
    };

interface SettingsRow {
  readonly baseUrl: string | null;
  readonly tokenEncrypted: string | null;
  readonly enabled: number;
  readonly allowPrivateNetwork: number;
}

/**
 * The supervisor token, or undefined.
 *
 * Read through a parameter rather than off `process.env` directly so a test can
 * drive both paths without touching the environment of the process it runs in
 * — which is shared, and which several other tests read.
 */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Which path we are on, and the credential for it.
 *
 * The supervisor wins when its token is present. A household running as an
 * add-on has a working connection they never configured, and preferring a
 * pasted token over it would mean a stale token silently outranking the live
 * one after somebody moved their installation.
 */
export function resolveConnection(
  db: SqliteDatabase,
  keyring: Keyring,
  env: Env = process.env,
): ConnectionResult {
  const supervisor = env['SUPERVISOR_TOKEN'];
  if (typeof supervisor === 'string' && supervisor !== '') {
    return {
      ok: true,
      connection: {
        mode: 'supervisor',
        baseUrl: SUPERVISOR_BASE,
        token: supervisor,
        /*
         * Plain http to a bare hostname on the container network.
         *
         * Both of those are refused by default, and rightly — but this URL is
         * a constant in this file rather than anything a household typed, and
         * `supervisor` is only resolvable at all from inside the add-on
         * network the supervisor itself put us on. The guard is still in the
         * path: it still pins the resolved address and still refuses a
         * redirect off this origin, which is what would matter if the
         * supervisor were ever tricked into issuing one.
         */
        policy: { allowHttp: true, allowPrivateNetwork: true },
        host: 'supervisor',
      },
    };
  }

  const row = db
    .prepare(
      `SELECT base_url AS baseUrl, token_encrypted AS tokenEncrypted, enabled,
              allow_private_network AS allowPrivateNetwork
         FROM ha_settings WHERE id = 'singleton'`,
    )
    .get() as SettingsRow | undefined;

  if (row === undefined || row.enabled !== 1 || row.baseUrl === null || row.tokenEncrypted === null) {
    return {
      ok: false,
      code: 'not-configured',
      message: 'Home Assistant is not connected.',
    };
  }

  const opened = keyring.decrypt(row.tokenEncrypted, 'ha-token');
  if (!opened.ok) {
    // Almost always a backup restored without /data/.secret. No amount of
    // retrying recovers a key that is gone, so say what to do instead.
    return {
      ok: false,
      code: 'key-lost',
      message: 'The stored Home Assistant token could not be read.',
      suggestion:
        'This usually means a backup was restored without its encryption key. ' +
        'Create a new long-lived access token in Home Assistant and paste it in again.',
    };
  }

  /*
   * The address a household typed is the root; the API lives under `/api`.
   *
   * Both are accepted, because half of them will paste the address bar and
   * half will paste something ending in `/api`, and neither is wrong enough to
   * refuse. The supervisor's own base already ends in `/api`, so normalising
   * here is what makes the two paths the same code afterwards — without it
   * every manual request went to the wrong place and came back 404, which
   * reads exactly like "Home Assistant has nothing in it".
   */
  const base = row.baseUrl.replace(/\/+$/, '').replace(/\/api$/i, '');
  const validated = validateOutboundUrl(base, {
    allowHttp: base.startsWith('http://'),
    allowPrivateNetwork: row.allowPrivateNetwork === 1,
    allowLoopback: row.allowPrivateNetwork === 1,
  });
  if (!validated.ok) {
    return { ok: false, code: 'bad-address', message: validated.error.message };
  }

  return {
    ok: true,
    connection: {
      mode: 'manual',
      baseUrl: `${base}/api`,
      token: opened.value,
      policy: {
        allowHttp: base.startsWith('http://'),
        allowPrivateNetwork: row.allowPrivateNetwork === 1,
        allowLoopback: row.allowPrivateNetwork === 1,
      },
      host: validated.value.hostname,
    },
  };
}

export type CallResult =
  | { readonly ok: true; readonly body: string }
  | {
      readonly ok: false;
      readonly message: string;
      readonly suggestion?: string;
      /**
       * The opt-ins that would open this address, in the flag names on
       * `UrlPolicy` — never in the words on the checkbox.
       *
       * This module cannot see the admin's label table (it is a module, and the
       * table is one layer up in `http/`), and when it tried to name the control
       * anyway it produced the product's *fifth* name for the same switch:
       * `Turn on "Home Assistant is on my local network"`. The screen composes
       * the sentence; this says which control it is about.
       *
       * Only the resolver knows a public-looking name landed on a LAN address,
       * so the URL gate cannot answer this one — it comes off the outcome.
       */
      readonly networkOptions?: readonly NetworkOption[];
    };

/**
 * One GET against Home Assistant.
 *
 * Every request in this integration goes through here, so there is exactly one
 * place the token is attached and exactly one place the outbound guard is
 * applied. The fetcher drops `authorization` on a cross-origin redirect by
 * itself — that is the case this would otherwise leak the house's token to
 * whatever a redirect pointed at.
 */
export async function call(
  fetcher: Fetcher,
  connection: Connection,
  path: string,
  timeoutMs = 10_000,
): Promise<CallResult> {
  const response = await fetcher.fetch({
    url: `${connection.baseUrl}${path}`,
    policy: connection.policy,
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs,
    headers: { authorization: `Bearer ${connection.token}` },
  });

  if (response.status === 'ok') return { ok: true, body: response.body };
  if (response.status === 'not-modified') {
    return { ok: false, message: 'Home Assistant answered with nothing.' };
  }

  return { ok: false, ...describe(response, connection) };
}

/**
 * A failure, said to somebody standing in a kitchen.
 *
 * A 401 is the one worth spelling out: it is the commonest thing that goes
 * wrong here, it never fixes itself, and "unauthorised" does not tell anybody
 * that their token was revoked when they last reinstalled Home Assistant.
 */
function describe(
  response:
    | {
        status: 'rejected';
        code: string;
        message: string;
        networkOptions?: readonly NetworkOption[];
      }
    | { status: 'failed'; code: string; message: string; httpStatus?: number },
  connection: Connection,
): { message: string; suggestion?: string; networkOptions?: readonly NetworkOption[] } {
  if (response.status === 'failed' && response.code === 'http-error') {
    if (response.httpStatus === 401 || response.httpStatus === 403) {
      return {
        message: 'Home Assistant refused the token.',
        suggestion:
          connection.mode === 'supervisor'
            ? 'The add-on may not have permission to reach Home Assistant. Check that ' +
              'homeassistant_api is on in the add-on configuration, and restart it.'
            : 'Long-lived access tokens are revoked when they are deleted in Home ' +
              'Assistant, and on some upgrades. Create a new one under your profile ' +
              'and paste it in again.',
      };
    }
    if (response.httpStatus === 404) {
      return {
        message: 'That address answered, but not with the Home Assistant API.',
        suggestion:
          'Give the address of Home Assistant itself, without /api on the end — ' +
          'for example http://192.168.1.10:8123',
      };
    }
  }

  if (response.status === 'rejected') {
    switch (response.code) {
      case 'dns-failed':
        return {
          message: `Could not look up ${connection.host}.`,
          suggestion:
            'If Home Assistant is on your network, use its IP address. Names ending ' +
            'in .local are resolved by the device you are browsing from, not by this ' +
            'server, so they usually will not work here.',
        };
      case 'address-rejected':
      case 'url-rejected':
        return {
          /*
           * Written here, never passed through — for the reason spelled out
           * below: this string is stored on `ha_settings.last_error`, which the
           * panel carries to the wall as a note, and the guard's own message
           * names the hostname *and* the address it resolved to. That is the
           * household's Home Assistant on a screen in their hallway.
           *
           * What changed is only the sentence after it: the remedy used to read
           * `Turn on "Home Assistant is on my local network"` and is now the
           * screen's to compose, from the table the checkbox is drawn from.
           */
          message: 'That address was refused by the outbound guard.',
          ...(response.networkOptions !== undefined && response.networkOptions.length > 0
            ? { networkOptions: response.networkOptions }
            : {}),
        };
      default:
        return { message: response.message };
    }
  }

  /*
   * Written here, never passed through.
   *
   * The fetcher's own message for a refused connection is the Node errno —
   * "connect ECONNREFUSED 127.0.0.1:8123" — and this string is stored on
   * `ha_settings.last_error`, which the panel carries to the wall as a note.
   * So the raw message put the household's Home Assistant address on a screen
   * in their hallway, which is the one thing this integration promises it does
   * not do. It also tells nobody standing in a kitchen anything.
   */
  switch (response.code) {
    case 'timeout':
      return { message: `${connection.host} did not answer in time.` };
    case 'network-error':
      return {
        message: 'Could not reach Home Assistant.',
        suggestion: 'Check it is running, and that the address on this page is still right.',
      };
    case 'too-large':
      return { message: 'Home Assistant answered with more than we will read.' };
    case 'unacceptable-content-type':
      return {
        message: 'That address answered, but not with the Home Assistant API.',
        suggestion: 'Give the address of Home Assistant itself, for example http://192.168.1.10:8123',
      };
    default:
      return { message: `Home Assistant returned an error (${response.code}).` };
  }
}

/**
 * Prove the connection works, and say what it is talking to.
 *
 * `/` is Home Assistant's own liveness endpoint and returns a message rather
 * than any state, so this is the one call that is safe to make from a form
 * somebody is filling in — a test button that dumped every entity in the house
 * into a validation path would be a worse idea than it looks.
 */
export async function testConnection(
  fetcher: Fetcher,
  connection: Connection,
): Promise<CallResult> {
  return call(fetcher, connection, '/');
}
