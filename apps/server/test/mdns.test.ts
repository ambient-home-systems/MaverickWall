import { afterEach, describe, expect, it } from 'vitest';
import { Bonjour, type Service } from 'bonjour-service';
import { startMdnsAdvertiser, MDNS_SERVICE_TYPE, type MdnsHandle } from '../src/net/mdns.js';

/**
 * The LAN advertiser, driven over real multicast sockets.
 *
 * The doctrine is why this browses for real rather than inspecting the service
 * object it published: the failure that matters is a wall that advertises an
 * address a tablet cannot reach, and only a real query decodes the port and TXT
 * a listening app actually sees. The one concession to a test environment is
 * the multicast *port*: a private one, so the round-trip is deterministic and
 * does not fight the host's own mDNS responder (which on macOS holds 5353 and
 * makes the default port undiscoverable in-process). The advertiser code under
 * test is the same; only where it broadcasts moves.
 */

// A non-standard mDNS port, so this test forms its own bus in isolation from
// the machine's real 5353 responder. Both the advertiser and the browser use
// it; production uses the default.
const TEST_MDNS_PORT = 5354;

const handles: MdnsHandle[] = [];
const browsers: Bonjour[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const bonjour of browsers.splice(0)) bonjour.destroy();
});

/** Browse the private bus and resolve with the first matching service. */
function discover(name: string, timeoutMs = 8000): Promise<Service> {
  const bonjour = new Bonjour({ port: TEST_MDNS_PORT });
  browsers.push(bonjour);
  return new Promise<Service>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service not discovered in time')), timeoutMs);
    bonjour.find({ type: MDNS_SERVICE_TYPE, protocol: 'tcp' }, (service: Service) => {
      if (service.name === name) {
        clearTimeout(timer);
        resolve(service);
      }
    });
  });
}

describe('the mDNS advertiser', () => {
  it('is discoverable, at the port and with the name a screen needs', async () => {
    const handle = startMdnsAdvertiser({
      port: 8080,
      name: 'Test Wall',
      version: '9.9.9',
      bonjourOptions: { port: TEST_MDNS_PORT },
    });
    expect(handle).toBeDefined();
    handles.push(handle as MdnsHandle);

    const service = await discover('Test Wall');
    // The port a tablet opens — the thing that was wrong in the pairing-QR bug.
    expect(service.port).toBe(8080);
    // The type both sides agree on, so the app's filter matches.
    expect(service.type).toBe(MDNS_SERVICE_TYPE);
    // TXT carries the readable name, the bundle path, and the version.
    expect(service.txt).toMatchObject({ name: 'Test Wall', path: '/', version: '9.9.9' });
  }, 10000);

  it('withdraws cleanly and stops twice without throwing', async () => {
    const handle = startMdnsAdvertiser({
      port: 8080,
      name: 'Ephemeral Wall',
      bonjourOptions: { port: TEST_MDNS_PORT },
    });
    expect(handle).toBeDefined();
    // Idempotent: a shutdown path may call it, and so may a caller, and neither
    // must fault the other. The second call is a no-op, not an error.
    expect(() => {
      handle?.stop();
      handle?.stop();
    }).not.toThrow();
  });

  it('omits the version from TXT when none is given', async () => {
    const handle = startMdnsAdvertiser({
      port: 8080,
      name: 'Versionless Wall',
      bonjourOptions: { port: TEST_MDNS_PORT },
    });
    handles.push(handle as MdnsHandle);

    const service = await discover('Versionless Wall');
    expect(service.txt).toMatchObject({ name: 'Versionless Wall', path: '/' });
    expect((service.txt as Record<string, unknown>)['version']).toBeUndefined();
  }, 10000);
});
