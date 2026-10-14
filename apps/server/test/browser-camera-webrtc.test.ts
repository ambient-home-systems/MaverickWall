/**
 * A camera over WebRTC on a real paired wall (Hard rule 12's WebRTC
 * exception), against the stand-in Home Assistant — whose media server is a
 * second Chromium page, so the video really travels peer to peer and the
 * signalling really goes through this server.
 *
 * What is proven on the glass: the box's picture is a `<video>` playing the
 * media server's frames, both of its colours; it is one video and one
 * session across rebuilds; the page never names Home Assistant's address, the
 * entity id or the token; and a camera that does not offer WebRTC falls back
 * to the MJPEG stream (M6.2) and draws its frames.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { watchCamera } from '../src/modules/cameras/index.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 150_000;
const DOOR = 'camera.front_door';
const installations: Installation[] = [];
const houses: FakeHa[] = [];
afterAll(async () => {
  for (const ha of houses) ha.dropSockets();
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

async function setUp(): Promise<{ app: Installation; ha: FakeHa; link: string }> {
  const app = await install({});
  installations.push(app);
  const ha = await fakeHomeAssistant();
  houses.push(ha);
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  expect(
    (await app.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' })).status,
  ).toBe(302);
  const added = watchCamera(app.db, { entityId: DOOR, name: 'Front door' }, app.now());
  if (!added.ok) throw new Error(added.message);
  const link = await app.pairLink('Kitchen');
  const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const at = app.now();
  app.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES ('cam', ?, 'portrait', 'camera', 0.05, 0.05, 0.6, 0.3, 0, ?, ?, ?)`,
    )
    .run(screen, JSON.stringify({ camera: added.handle, cameraMode: 'webrtc' }), at, at);
  return { app, ha, link };
}

/** A media server in a page of its own: answers an offer with a canvas flipping red and blue. */
async function mediaServer(ha: FakeHa): Promise<Page> {
  const page = await (await browser()).newPage();
  await page.setContent('<!doctype html><title>go2rtc</title>');
  ha.webrtc = async (_entity, offer, send) => {
    const answer = await page.evaluate(async (sdp) => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      let tick = 0;
      setInterval(() => {
        ctx.fillStyle = tick++ % 10 < 5 ? '#ff0000' : '#0000ff';
        ctx.fillRect(0, 0, 320, 240);
      }, 100);
      const stream = canvas.captureStream(10);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      (window as unknown as { pcs: RTCPeerConnection[] }).pcs = [
        ...((window as unknown as { pcs?: RTCPeerConnection[] }).pcs ?? []),
        pc,
      ];
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        });
        setTimeout(resolve, 3_000);
      });
      return pc.localDescription?.sdp ?? '';
    }, offer);
    send({ type: 'answer', answer });
  };
  return page;
}

const videoColour = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#camera-layer video');
    if (video === null || video.videoWidth === 0) return 'none';
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(video, 0, 0);
    const [r = 0, , b = 0] = ctx.getImageData(10, 10, 1, 1).data;
    return r > 150 && b < 100 ? 'red' : b > 150 && r < 100 ? 'blue' : 'other';
  });

describe('a camera over WebRTC on a wall', () => {
  it(
    'plays the media server’s video straight to the glass, on one session across rebuilds, and names nothing of Home Assistant',
    async () => {
      const { ha, link } = await setUp();
      const media = await mediaServer(ha);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const asked: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/d/camera')) asked.push(`${request.method()} ${new URL(request.url()).pathname}`);
        });
        await page.waitForFunction(
          () => document.querySelector('#camera-layer .camera-pic.is-live video') !== null,
          undefined,
          { timeout: 25_000 },
        );
        const seen = new Set<string>();
        for (let i = 0; i < 60 && seen.size < 2; i++) {
          seen.add(await videoColour(page));
          await page.waitForTimeout(100);
        }
        expect([...seen].filter((c) => c === 'red' || c === 'blue').sort()).toEqual(['blue', 'red']);

        const facts = await page.evaluate(() => {
          const pic = document.querySelector<HTMLElement>('#camera-layer .camera-pic');
          const box = document.querySelector<HTMLElement>('#wall .fw[data-widget-id="cam"] .fw-camera');
          const r = (el: Element | null) => {
            const b = el?.getBoundingClientRect();
            return b === undefined ? undefined : [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
          };
          (document.querySelector('#camera-layer video') as HTMLVideoElement & { __tagged?: boolean }).__tagged = true;
          return { picture: r(pic), box: r(box), html: document.documentElement.outerHTML };
        });
        expect(facts.picture).toEqual(facts.box);
        for (const secret of [DOOR, TOKEN, ha.base]) expect(facts.html).not.toContain(secret);

        // A rebuild or two: the same video, still the one session into the house.
        // (The listener above may have been attached after the offer was sent,
        // so what is counted from here is only what the rebuilds ask for.)
        expect(ha.webrtcSessions).toHaveLength(1);
        asked.length = 0;
        await page.waitForTimeout(16_000);
        expect(
          await page.evaluate(
            () => (document.querySelector('#camera-layer video') as (HTMLVideoElement & { __tagged?: boolean }) | null)?.__tagged === true,
          ),
        ).toBe(true);
        expect(ha.webrtcSessions).toEqual([{ entityId: DOOR, open: true }]);
        expect(asked.filter((a) => a.startsWith('POST /d/camera/'))).toEqual([]);
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.every((a) => /^GET \/d\/camera-session\/[A-Za-z0-9_-]{22}$/.test(a))).toBe(true);
      } finally {
        await opened.close();
        await media.close();
      }
    },
    SLOW,
  );

  it(
    'falls back to the MJPEG stream when the camera does not offer WebRTC',
    async () => {
      const { ha, link } = await setUp();
      // No media server: core refuses the offer.
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForFunction(
          () => document.querySelector('#camera-layer .camera-pic.is-live canvas') !== null,
          undefined,
          { timeout: 25_000 },
        );
        expect(await page.evaluate(() => document.querySelector('#camera-layer video'))).toBeNull();
        expect(ha.streamOpens).toBe(1);
        expect(ha.webrtcSessions).toEqual([]);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
