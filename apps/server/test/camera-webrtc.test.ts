import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { watchCamera } from '../src/modules/cameras/index.js';
import { candidateFrom, type WebrtcLimits } from '../src/modules/cameras/webrtc.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * A camera over WebRTC (Hard rule 12's WebRTC exception), against the real
 * app, the real fetcher and a stand-in Home Assistant that answers
 * `camera/webrtc/offer` the way core does: a result, a session, an answer and
 * candidates as events, and the session ended when its socket closes.
 *
 * What is proven: the wall's offer reaches Home Assistant for the entity the
 * handle names and nothing else is sent; the wall gets the answer and the
 * media server's candidates and never the entity id, Home Assistant's address
 * or the token; a camera that does not offer WebRTC is a 409 the wall falls
 * back from; the socket is held while the wall polls and closed when it stops,
 * when it ends the session, when it is revoked and when the answer never
 * comes; and a wall cannot read another wall's session.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
const DOOR = 'camera.front_door';

const houses: FakeHa[] = [];

afterAll(async () => {
  // A held session is a held socket, and a server waits for its sockets to close.
  for (const ha of houses) ha.dropSockets();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
  await closeFakeHomeAssistants();
});

const until = async (what: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly handle: string;
  readonly wall: (screen: string, path: string, init?: RequestInit) => Promise<Response>;
}

async function harness(limits: Partial<WebrtcLimits> = {}, mode = 'webrtc'): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  houses.push(ha);
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-webrtc-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.63.${n}.1`,
    setupToken,
    dataDir,
    webrtcLimits: limits,
  });
  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    admin(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `webrtc${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  const added = watchCamera(db, { entityId: DOOR, name: 'Front door' }, stamp);
  if (!added.ok) throw new Error(added.message);
  const tokens = new Map<string, string>();
  for (const id of ['kitchen', 'hall']) {
    const display = issueDisplayToken();
    tokens.set(id, display.token);
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'panels', ?, 'freeform', ?, ?)`,
    ).run(id, id, display.tokenHash, stamp, stamp, stamp);
    db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, 'portrait', 'camera', 0, 0, 0.5, 0.5, 0, ?, ?, ?)`,
    ).run(`cam-${id}`, id, JSON.stringify({ camera: added.handle, cameraMode: mode }), stamp, stamp);
  }
  return {
    db,
    ha,
    handle: added.handle,
    wall: async (screen, path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${tokens.get(screen) ?? ''}`);
      return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    },
  };
}


const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=recvonly\r\n';
const ANSWER = 'v=0\r\no=go2rtc 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n';
const GO2RTC = 'candidate:1 1 udp 2130706431 192.168.1.20 8555 typ host';
const LATE = 'candidate:2 1 tcp 1694498815 192.168.1.20 8555 typ host tcptype passive';

/** A stand-in media server: an answer and one candidate at once, one more a moment later. */
function answering(ha: FakeHa): void {
  ha.webrtc = (_entity, _offer, send) => {
    send({ type: 'answer', answer: ANSWER });
    send({ type: 'candidate', candidate: { candidate: GO2RTC, sdpMid: '0', sdpMLineIndex: 0 } });
    setTimeout(() => send({ type: 'candidate', candidate: { candidate: LATE, sdp_m_line_index: 0 } }), 150);
  };
}

const offer = (h: Harness, screen = 'kitchen', sdp = OFFER): Promise<Response> =>
  h.wall(screen, `/d/camera/${h.handle}/webrtc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offer: sdp }),
  });

describe('a camera over WebRTC', () => {
  it('hands the wall the answer and the media server’s candidates, and nothing of Home Assistant', async () => {
    const h = await harness();
    answering(h.ha);
    const response = await offer(h);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { session: string; answer: string; candidates: { candidate: string }[] };
    expect(body.answer).toBe(ANSWER);
    expect(body.candidates).toEqual([{ candidate: GO2RTC, sdpMid: '0', sdpMLineIndex: 0 }]);
    for (const secret of [DOOR, TOKEN, h.ha.base, '127.0.0.1:' + new URL(h.ha.base).port]) expect(text).not.toContain(secret);

    // What reached the house: the handshake, then the offer for this entity, verbatim.
    const sent = h.ha.wsReceived.map((m) => JSON.parse(m) as Record<string, unknown>);
    expect(sent.map((m) => m['type'])).toEqual(['auth', 'camera/webrtc/offer']);
    expect(sent[1]).toMatchObject({ entity_id: DOOR, offer: OFFER });

    // A late candidate arrives by the poll, and the socket is held meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const polled = (await (await h.wall('kitchen', `/d/camera-session/${body.session}?after=1`)).json()) as {
      candidates: { candidate: string; sdpMLineIndex?: number }[];
      ended: boolean;
    };
    expect(polled).toEqual({ ended: false, candidates: [{ candidate: LATE, sdpMLineIndex: 0 }] });
    expect(h.ha.webrtcSessions).toEqual([{ entityId: DOOR, open: true }]);

    // Ending it closes the socket, which is what ends the session in Home Assistant.
    await h.wall('kitchen', `/d/camera-session/${body.session}/end`, { method: 'POST' });
    await until(() => h.ha.webrtcSessions[0]?.open === false);
    expect((await h.wall('kitchen', `/d/camera-session/${body.session}`)).status).toBe(404);
  });

  it('is a sentence the wall falls back from when the camera does not offer WebRTC', async () => {
    const h = await harness();
    const response = await offer(h);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/^This camera does not offer WebRTC through Home Assistant/);
    expect(body.message).not.toContain(DOOR);
  });

  it('refuses an offer that is not one, and a camera this wall does not show', async () => {
    const h = await harness();
    answering(h.ha);
    expect((await offer(h, 'kitchen', 'not an offer')).status).toBe(400);
    expect((await h.wall('kitchen', `/d/camera/${'x'.repeat(43)}/webrtc`, { method: 'POST', body: JSON.stringify({ offer: OFFER }) })).status).toBe(404);
    h.db.prepare(`DELETE FROM layout_widgets WHERE screen_id = 'hall'`).run();
    expect((await offer(h, 'hall')).status).toBe(404);
    expect(h.ha.webrtcSessions).toEqual([]);
  });

  it('lets no wall read another wall’s session', async () => {
    const h = await harness();
    answering(h.ha);
    const body = (await (await offer(h)).json()) as { session: string };
    expect((await h.wall('hall', `/d/camera-session/${body.session}`)).status).toBe(404);
    await h.wall('hall', `/d/camera-session/${body.session}/end`, { method: 'POST' });
    expect(h.ha.webrtcSessions[0]?.open).toBe(true);
  });

  it('closes a session the wall has stopped polling', async () => {
    const h = await harness({ idleMs: 300 });
    answering(h.ha);
    expect((await offer(h)).status).toBe(200);
    await until(() => h.ha.webrtcSessions[0]?.open === false, 3_000);
  });

  it('closes a session within a second or two of its wall being revoked', async () => {
    const h = await harness();
    answering(h.ha);
    const body = (await (await offer(h)).json()) as { session: string };
    h.db.prepare(`UPDATE screens SET revoked_at = ? WHERE id = 'kitchen'`).run(Date.now());
    await until(() => h.ha.webrtcSessions[0]?.open === false, 3_000);
    expect(body.session).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('gives up on an answer that never comes, and closes the socket', async () => {
    const h = await harness({ answerMs: 300 });
    h.ha.webrtc = () => undefined;
    const response = await offer(h);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).toBe('Home Assistant did not answer in time.');
    await until(() => h.ha.webrtcSessions[0]?.open === false);
  });

  it('holds a wall to its share of sessions', async () => {
    const h = await harness({ perScreen: 1 });
    answering(h.ha);
    expect((await offer(h)).status).toBe(200);
    const second = await offer(h);
    expect(second.status).toBe(503);
    expect(((await second.json()) as { message: string }).message).toBe('This wall is already showing as many live cameras as it can.');
    expect((await offer(h, 'hall')).status).toBe(200);
  });
});

describe('a candidate from Home Assistant', () => {
  it('is read in either spelling, and nothing that is not a candidate line gets through', () => {
    expect(candidateFrom({ candidate: GO2RTC, sdp_mid: '0', sdp_m_line_index: 0 })).toEqual({ candidate: GO2RTC, sdpMid: '0', sdpMLineIndex: 0 });
    expect(candidateFrom(`a=${GO2RTC}`)).toEqual({ candidate: GO2RTC });
    expect(candidateFrom({ candidate: '' })).toBeUndefined();
    expect(candidateFrom({ candidate: `${GO2RTC}\r\na=evil` })).toBeUndefined();
    expect(candidateFrom({ candidate: 'http://homeassistant.local:8123/api' })).toBeUndefined();
    expect(candidateFrom({ candidate: GO2RTC, sdpMLineIndex: 9_999 })).toEqual({ candidate: GO2RTC });
    expect(candidateFrom(42)).toBeUndefined();
  });
});
