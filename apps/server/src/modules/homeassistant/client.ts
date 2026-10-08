import { FETCH_LIMITS, validateOutboundUrl, type Fetcher, type NetworkOption, type UrlPolicy } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { isIssuedCall, type HaCall } from './services.js';

/**
 * The Home Assistant connection: two credential paths, one client.
 *
 * **A frozen table of verbs, one constructor, one door.** `HA_SERVICES` below
 * is the allowlist (rule 12, RFC 018 §5), `buildCall` is the only thing that
 * can make a call from it, and `callService` is the only thing in this
 * repository that reaches `Fetcher.postJson`. This is a security property
 * rather than a missing feature; the note on the token below is why it has to
 * be one.
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
 *   - Nothing here writes except what `HA_SERVICES` names, and each of those
 *     is confined to something the household picked: an item on a to-do list
 *     they added (RFC 012), and — once RFC 018's later phases wire a caller —
 *     an entity they marked controllable, on a wall they allowed, from a widget
 *     they set to act. The display still receives resolved values and handles
 *     this server minted, never an entity id, never a proxy endpoint, and never
 *     the token. So the blast radius of a compromised wall tablet is at most
 *     "somebody turned off my kitchen light", and it is not, and must never
 *     become, "somebody opened my garage": no row in the table can reach a
 *     lock, an alarm, or a garage, gate, door or window cover.
 *
 * Two things follow from the handle that are not obvious. A compromised wall
 * can tick **only items it has been shown** — it cannot enumerate lists, cannot
 * reach a list the household did not add, and cannot construct a handle for
 * one. And the existing test asserting the manifest contains no entity id and
 * no base URL now covers a write path as well as a read one, which needs no
 * change to that test and is the point of having had it.
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
       * The upstream's status when there was one. `describe` writes the
       * sentence for the common case of each code — a 404 is "that address is
       * not the Home Assistant API", which is right for the root and wrong for
       * `/states/<entity>`, where it means the entity is gone. A caller that
       * asked about one thing can say so from the code without matching the
       * sentence, which this file otherwise refuses to do.
       */
      readonly httpStatus?: number;
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

  return {
    ok: false,
    ...describe(response, connection),
    ...(response.status === 'failed' && response.httpStatus !== undefined
      ? { httpStatus: response.httpStatus }
      : {}),
  };
}

/**
 * A picture Home Assistant serves — a media player's artwork (plan item M3.4)
 * — as bytes.
 *
 * Beside `call` because the token is attached in this file and nowhere else.
 * The path is Home Assistant's own (`/api/…`), joined to the connection's
 * origin and checked to stay there, so a picture address cannot be the thing
 * that sends the house's token somewhere else.
 */
export async function callPicture(
  fetcher: Fetcher,
  connection: Connection,
  path: string,
): Promise<{ readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly message: string }> {
  if (!path.startsWith('/api/') || path.includes('..')) return { ok: false, message: 'That is not a Home Assistant picture.' };
  const url = `${connection.baseUrl.replace(/\/api$/, '')}${path}`;
  const response = await fetcher.fetch({
    url,
    policy: connection.policy,
    maxBytes: FETCH_LIMITS.image,
    timeoutMs: 15_000,
    headers: { authorization: `Bearer ${connection.token}` },
    bodyEncoding: 'base64',
  });
  if (response.status !== 'ok') return { ok: false, message: 'Home Assistant did not hand over the picture.' };
  return { ok: true, bytes: Buffer.from(response.body, 'base64') };
}

/*
 * The allowlist and its one constructor live in `services.ts`, which is pure:
 * the table, the eligibility rules and the value bounds can be tested without a
 * network. Re-exported here so every caller keeps one import for the Home
 * Assistant client. RFC 018 §5 is the table's specification.
 */
export {
  buildCall,
  COVER_CLASSES,
  HA_SERVICES,
  type BuildResult,
  type CallRequest,
  type ControlKey,
  type HaCall,
  type RefusalCode,
  type ServiceKey,
  type ServiceRow,
} from './services.js';

/**
 * One POST against Home Assistant, and the only door there is.
 *
 * The single caller of `Fetcher.postJson` in this repository. Everything about
 * the credential is `call`'s: the same bearer header, attached in one place, and
 * the same `describe` afterwards so a household reads the sentences already
 * written for a kitchen rather than a second set that drifted from them.
 *
 * **It sends only a call `buildCall` issued.** The type says so, which makes a
 * hand-built call a compile error; and the door checks again at run time, which
 * is the half a cast cannot get round. So the table in `services.ts` is the
 * whole of what can be posted, and `ha-write-boundary.test.ts` proves both that
 * this is the only door and that it refuses a call nobody built.
 *
 * `postJson` refuses a redirect outright, so the token and the body reach the
 * address the guard approved or they reach nowhere.
 */
export async function callService(
  fetcher: Fetcher,
  connection: Connection,
  call: HaCall,
  options: { readonly timeoutMs?: number } = {},
): Promise<CallResult> {
  if (!isIssuedCall(call)) {
    return {
      ok: false,
      message: 'That is not a call Maverick Wall makes, so it was not sent.',
      suggestion: 'This is a fault in Maverick Wall rather than in Home Assistant.',
    };
  }
  const query = call.returnResponse ? '?return_response' : '';
  const response = await fetcher.postJson({
    url: `${connection.baseUrl}/services/${call.service}${query}`,
    policy: connection.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: options.timeoutMs ?? 10_000,
    headers: { authorization: `Bearer ${connection.token}` },
    body: call.body,
  });

  if (response.status === 'ok') return { ok: true, body: response.body };
  return {
    ok: false,
    ...describe(response, connection),
    ...(response.status === 'failed' && response.httpStatus !== undefined
      ? { httpStatus: response.httpStatus }
      : {}),
  };
}

/**
 * A failure, said to somebody standing in a kitchen.
 *
 * A 401 is the one worth spelling out: it is the commonest thing that goes
 * wrong here, it never fixes itself, and "unauthorised" does not tell anybody
 * that their token was revoked when they last reinstalled Home Assistant.
 */
/**
 * The one shape of 400 that means we asked wrongly.
 *
 * Home Assistant refuses a service call that answers with data unless the
 * caller said `?return_response`, and it says so in those words. That is the
 * only failure on this path that is *ours* rather than theirs, so it earns a
 * sentence of its own: everything else a 400 could be is a fact about their
 * server or their list, and telling a household to check their token over a
 * missing query parameter would send them somewhere with nothing wrong with it.
 *
 * Matched on the wording, which this file otherwise refuses to do — the gzip
 * branch in the fetcher and `networkErrorMessage` both key on codes for exactly
 * that reason. There is no code here to key on: Home Assistant answers a bare
 * 400 and puts the whole diagnosis in the prose. So the match is deliberately
 * narrow and failing it costs nothing, because the generic branch below already
 * carries the upstream's own sentence.
 */
function isMissingReturnResponse(body: string | undefined): boolean {
  if (body === undefined) return false;
  return /requires responses but caller did not ask for responses/i.test(body);
}

/**
 * A stranger's sentence, made safe to draw.
 *
 * Home Assistant's `{"message": "..."}` is written by Home Assistant, but the
 * *contents* can carry a household's own entity names and whatever an
 * integration put there — and this string is stored on `ha_settings.last_error`,
 * which the panel carries to the wall as a note. So it is capped and stripped
 * of control characters the way every other stranger's text on this wall is.
 */
function upstreamMessage(body: string | undefined): string | undefined {
  if (body === undefined || body === '') return undefined;
  let text: string;
  try {
    const parsed: unknown = JSON.parse(body);
    const message =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['message']
        : undefined;
    if (typeof message !== 'string' || message === '') return undefined;
    text = message;
  } catch {
    // Not our shape. A stray HTML error page is not a diagnosis worth drawing.
    return undefined;
  }
  const cleaned = text.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' ? undefined : cleaned.slice(0, 200);
}

function describe(
  response:
    | {
        status: 'rejected';
        code: string;
        message: string;
        networkOptions?: readonly NetworkOption[];
      }
    | {
        status: 'failed';
        code: string;
        message: string;
        httpStatus?: number;
        responseBody?: string;
      },
  connection: Connection,
): { message: string; suggestion?: string; networkOptions?: readonly NetworkOption[] } {
  if (response.status === 'failed' && response.code === 'http-error') {
    if (response.httpStatus === 400 && isMissingReturnResponse(response.responseBody)) {
      return {
        message: 'Home Assistant refused that request because it was not asked correctly.',
        suggestion:
          'This one is a fault in Maverick Wall rather than in your Home Assistant — ' +
          'nothing on your side needs changing. Please report it.',
      };
    }
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
    /*
     * Anything else it refused, in its own words.
     *
     * Only Home Assistant knows why a particular list or item was refused —
     * an integration that is reloading, a list that was deleted on somebody's
     * phone — and "the server answered 400" tells a household nothing they can
     * act on. This is the reason `postJson` keeps a non-2xx body at all, and it
     * is the only place a sentence from upstream is drawn rather than replaced.
     * Only ever reached for a POST: `fetch` carries no `responseBody`, so a GET
     * falls straight through to the generic line below exactly as before.
     */
    const upstream = upstreamMessage(response.responseBody);
    if (upstream !== undefined) {
      return { message: `Home Assistant refused that request: ${upstream}` };
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
