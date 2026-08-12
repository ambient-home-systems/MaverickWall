import { Bonjour, type Service, type ServiceConfig } from 'bonjour-service';

/**
 * Advertising the wall on the LAN, so the app finds it with no typed address.
 *
 * The owner's standing objection is "no hand-typed addresses, no port hunting"
 * ([[pairing-setup-must-be-frictionless]]). This is the server half: it
 * announces `_maverickwall._tcp` over multicast DNS with the port a screen
 * connects to and a readable instance name, and the Android app browses for it.
 *
 * Two rules govern the whole file:
 *
 * - **Rule three (no cloud):** mDNS is link-local by construction — it never
 *   leaves the household's own network segment. No registry, no relay, nothing
 *   to reach beyond the LAN. `bonjour-service` is pure JavaScript
 *   (`multicast-dns`), so it adds no native module to fight over in the
 *   multi-arch image, the same reason `setpriv` was chosen over `gosu`.
 * - **Rule nine (never brick the wall):** advertising is a convenience, never
 *   a dependency. The app always has manual host entry as a fallback, so a
 *   failure here — a port already held by the host's own mDNS under the add-on,
 *   a segmented network, a socket that will not bind — must degrade to "not
 *   discoverable", never to a boot that stops. Every path returns or logs; none
 *   throws.
 */

/**
 * The service type, advertised as `_maverickwall._tcp.local`.
 *
 * Fixed here and matched by the app; it is the string the browser filters on,
 * so the two must agree exactly. `bonjour-service` adds the `_` and `.local`.
 */
export const MDNS_SERVICE_TYPE = 'maverickwall';

/** The default instance name when the household has not set one. */
export const MDNS_DEFAULT_NAME = 'Maverick Wall';

export interface MdnsAdvertiserOptions {
  /**
   * The port a wall screen actually reaches — the mapped host port under the
   * add-on, not the container-internal one. Advertising the internal port would
   * send a tablet at an address it cannot open, the same class of mistake as
   * the pairing QR that carried the supervisor's internal Docker address.
   */
  readonly port: number;
  /** The name the app lists this server under. Keep it human, never a secret. */
  readonly name: string;
  /** App version, for diagnostics in the TXT record. Optional. */
  readonly version?: string;
  /**
   * Passed straight to `bonjour-service` / `multicast-dns`.
   *
   * Production passes nothing, so the standard mDNS port (5353) and group are
   * used. A test overrides `port` to stand up a private multicast bus and get a
   * deterministic publish→browse round-trip without colliding with the host's
   * own mDNS responder — which on macOS holds 5353 and makes the default port
   * undiscoverable in-process.
   */
  readonly bonjourOptions?: Partial<ServiceConfig>;
  /** Where a line about the advertiser goes. Hostnames/ports only — rule six. */
  readonly log?: (message: string) => void;
}

export interface MdnsHandle {
  /** Withdraw the advertisement and close the socket. Idempotent. */
  stop(): void;
}

/**
 * Start advertising, or return `undefined` if it could not start.
 *
 * Never throws: a caller can ignore the return value entirely and boot is
 * unaffected. The one thing it must not do is take the process down, so every
 * failure — construction, publish, or an asynchronous socket error — is caught
 * and logged rather than propagated.
 */
export function startMdnsAdvertiser(opts: MdnsAdvertiserOptions): MdnsHandle | undefined {
  const log = opts.log ?? ((): void => {});

  let bonjour: Bonjour;
  try {
    // The error callback is the asynchronous half of the guard: a socket that
    // fails to bind (the host's mDNS already on 5353 under the add-on) or errors
    // later surfaces here rather than as an unhandled 'error' that would crash
    // the process. Logged, not thrown — the wall keeps working without it.
    bonjour = new Bonjour(opts.bonjourOptions, (error: unknown) => {
      log(`[mdns] advertiser socket error: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  } catch (error) {
    log(`[mdns] could not start: ${error instanceof Error ? error.message : 'unknown'}`);
    return undefined;
  }

  let service: Service | undefined;
  try {
    service = bonjour.publish({
      name: opts.name,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      port: opts.port,
      // The app reads these to label and reach the server; the path is where
      // the display bundle lives, always the root here.
      txt: {
        name: opts.name,
        path: '/',
        ...(opts.version !== undefined ? { version: opts.version } : {}),
      },
    });
  } catch (error) {
    log(`[mdns] could not publish: ${error instanceof Error ? error.message : 'unknown'}`);
    try {
      bonjour.destroy();
    } catch {
      // Already down; nothing to clean up.
    }
    return undefined;
  }

  log(`[mdns] advertising ${opts.name} as _${MDNS_SERVICE_TYPE}._tcp on port ${opts.port}`);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        // Withdraw the record with a goodbye before tearing the socket down, so
        // a listening app drops us promptly rather than waiting out the TTL.
        service?.stop?.();
        bonjour.unpublishAll(() => {
          try {
            bonjour.destroy();
          } catch {
            // Socket already closed.
          }
        });
      } catch (error) {
        log(`[mdns] stop failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    },
  };
}
