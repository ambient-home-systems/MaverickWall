/**
 * The now-playing card (plan item M6.9) and the Notifications widget (plan
 * item M6.11), measured on a real paired wall.
 *
 * Seeded the way `browser-ha-status` seeds its house: rows straight into the
 * cache the house panel reads — a speaker playing a song ninety seconds in,
 * with a sleeve the house cannot serve here (it is not reachable), so the
 * card's picture gives way to its mark; and a door whose state a tile rule
 * matches.
 *
 *  1. **The card says what plays and fits its box**: title, artist and the
 *     speaker, the title the card's one large reading and at most 1.8 times
 *     the words under it, nothing outside the box.
 *  2. **The bar is counted on the wall's own clock**: moving the server's
 *     clock a minute on moves the fill by a minute of the song, with the
 *     manifest unchanged.
 *  3. **The transport is three buttons that press the one door**: each posts
 *     its word and the player's handle — never an entity id — to `/d/ha/act`,
 *     and they are drawn only behind the three switches.
 *  4. **A tile rule is said in the widget, never over the wall**, and its OK
 *     acknowledges it by its handle; the widget then has nothing to say and
 *     its fallback takes the box.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { haReadingHandle } from '../src/api/manifest.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant } from './fake-home-assistant.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const PORTRAIT = { width: 1080, height: 1920 };
const PLAYER = 'media_player.kitchen';

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  const at = wall.now();
  equipHousehold(wall.db, at);
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', at);
  const playing = JSON.stringify({
    device_class: null,
    // PAUSE | VOLUME_SET | PREVIOUS | NEXT | PLAY.
    supported_features: 1 | 4 | 16 | 32 | 16384,
    volume_level: 0.4,
    picture_key: 'cd'.repeat(32),
    media_title: 'Here Comes the Sun',
    media_artist: 'The Beatles',
    media_album_name: 'Abbey Road',
    media_duration: 240,
    media_position: 90,
    media_position_updated_at: new Date(at).toISOString(),
  });
  const insert = wall.db.prepare(
    `INSERT INTO ha_entity_cache
       (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
        fetched_at, watched, display_mode, label, sort_order, controllable)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 'label_value', NULL, ?, ?)`,
  );
  insert.run(PLAYER, 'playing', playing, 'Kitchen speaker', at - 20 * 60_000, at, 0, 1);
  insert.run('binary_sensor.freezer_door', 'on', '{"device_class":"door"}', 'Freezer door', at - 20 * 60_000, at, 1, 0);
  screenId = await wall.pairWall('Kitchen');
  wall.db.prepare('UPDATE screens SET allow_control = 1, allow_dismiss = 1 WHERE id = ?').run(screenId);
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Box {
  readonly id: string;
  readonly type: string;
  readonly config: Record<string, unknown>;
  readonly y: number;
  readonly h: number;
}

/** Classic's own canvas with these boxes across the top, saved through the real route. */
async function place(boxes: readonly Box[]): Promise<void> {
  const classic = readLayoutWidgets(wall.db, screenId, 'portrait').filter(
    (row) => row.type !== 'homeassistant' && row.type !== 'notifications',
  );
  const aspects = wall.db.prepare('SELECT layout_aspect AS p FROM screens WHERE id = ?').get(screenId) as { p: number };
  const widgets = [
    ...classic.map((row) => ({
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ...(row.config !== null && typeof row.config === 'object' && Object.keys(row.config).length > 0
        ? { config: row.config }
        : {}),
    })),
    ...boxes.map((box, index) => ({ id: box.id, type: box.type, x: 0.05, y: box.y, w: 0.9, h: box.h, z: 100 + index, config: box.config })),
  ];
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspects.p, widgets }),
  });
  expect(saved.status).toBe(200);
}

const CARD = { variant: 'media', readings: [PLAYER], tapAction: 'act' };

async function readCard(page: Page, id: string) {
  return page.evaluate((widgetId) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    if (box === null) throw new Error(`no box ${widgetId}`);
    const card = box.querySelector<HTMLElement>('.house-media');
    if (card === null) throw new Error('no card');
    const size = (selector: string): number => {
      const node = card.querySelector<HTMLElement>(selector);
      return node === null ? 0 : Number.parseFloat(getComputedStyle(node).fontSize);
    };
    const text = (selector: string): string | undefined => card.querySelector(selector)?.textContent ?? undefined;
    const outer = box.getBoundingClientRect();
    const spill = [...card.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        if (getComputedStyle(node).display === 'none' || node.closest('[style*="display: none"]') !== null) return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && (r.right > outer.right + 1 || r.bottom > outer.bottom + 1 || r.left < outer.left - 1);
      })
      .map((node) => `${node.className} ${JSON.stringify(node.getBoundingClientRect())} in ${JSON.stringify(outer)}`);
    const track = card.querySelector<HTMLElement>('.mp-progress');
    const fill = card.querySelector<HTMLElement>('.mp-fill');
    return {
      title: text('.mp-title'),
      artist: text('.mp-artist'),
      player: text('.mp-player'),
      titleSize: size('.mp-title'),
      artistSize: size('.mp-artist'),
      spill,
      fraction: track === null || fill === null ? undefined : fill.getBoundingClientRect().width / track.getBoundingClientRect().width,
      at: text('.mp-at'),
      buttons: [...card.querySelectorAll<HTMLButtonElement>('.mp-button')].map((button) => ({
        text: button.textContent,
        act: button.getAttribute('data-ha-act'),
        action: button.getAttribute('data-ha-action'),
      })),
      art: card.querySelector('.mp-picture') !== null,
    };
  }, id);
}

describe('the now-playing card on a wall (M6.9)', () => {
  it('says what plays, as one large reading, inside its box', async () => {
    await place([{ id: 'np', type: 'homeassistant', config: CARD, y: 0.02, h: 0.18 }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const card = await readCard(page, 'np');
      expect(card.title).toBe('Here Comes the Sun');
      expect(card.artist).toBe('The Beatles');
      expect(card.player).toBe('Kitchen speaker · Playing');
      expect(card.titleSize).toBeGreaterThan(card.artistSize);
      expect(card.titleSize / card.artistSize).toBeLessThanOrEqual(1.8 + 1e-6);
      expect(card.spill).toEqual([]);
      // The sleeve the house cannot serve here gives way, never a broken box.
      await page.waitForFunction(() => document.querySelector('.house-media .mp-picture') === null, null, { timeout: 10_000 });
    } finally {
      await close();
    }
  }, SLOW);

  it('counts the bar on with the wall’s own clock', async () => {
    await place([{ id: 'np', type: 'homeassistant', config: CARD, y: 0.02, h: 0.18 }]);
    const first = await (async () => {
      const { page, close } = await loadWallSettled(link, PORTRAIT);
      try {
        return await readCard(page, 'np');
      } finally {
        await close();
      }
    })();
    const etag = (await wall.call(`/d/manifest`)).headers.get('etag');
    wall.shiftClock(60_000);
    try {
      const { page, close } = await loadWallSettled(link, PORTRAIT);
      try {
        const later = await readCard(page, 'np');
        expect(first.fraction).toBeDefined();
        // Ninety seconds in, then a minute later: a quarter of the song more.
        expect((later.fraction ?? 0) - (first.fraction ?? 0)).toBeCloseTo(60 / 240, 1);
        expect(later.at).not.toBe(first.at);
      } finally {
        await close();
      }
    } finally {
      wall.shiftClock(-60_000);
    }
    expect((await wall.call(`/d/manifest`)).headers.get('etag')).toBe(etag);
  }, SLOW);

  it('presses the one door with a handle and a word, behind the three switches', async () => {
    await place([{ id: 'np', type: 'homeassistant', config: CARD, y: 0.02, h: 0.18 }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const card = await readCard(page, 'np');
      expect(card.buttons.map((b) => b.action)).toEqual(['previous', 'play_pause', 'next', 'panel']);
      expect(card.buttons.map((b) => b.text)).toEqual(['Previous', 'Pause', 'Next', 'More']);
      expect(new Set(card.buttons.map((b) => b.act))).toEqual(new Set([haReadingHandle(PLAYER)]));
      const posted: string[] = [];
      await page.route('**/d/ha/act', async (route) => {
        posted.push(route.request().postData() ?? '');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.click('.fw[data-widget-id="np"] .mp-button[data-ha-action="next"]');
      await expect.poll(() => posted.length).toBe(1);
      const body = new URLSearchParams(posted[0]);
      expect(body.get('action')).toBe('next');
      expect(body.get('reading')).toBe(haReadingHandle(PLAYER));
      expect(posted[0]).not.toContain('media_player');
      // More opens the speaker's own panel, with its volume.
      await page.click('.fw[data-widget-id="np"] .mp-more');
      await page.waitForSelector('.hc-panel input[data-hc-action="volume"]');
    } finally {
      await close();
    }
    // Without the widget's switch, a picture of what plays and nothing to press.
    await place([{ id: 'np', type: 'homeassistant', config: { variant: 'media', readings: [PLAYER] }, y: 0.02, h: 0.18 }]);
    const quiet = await loadWallSettled(link, PORTRAIT);
    try {
      expect((await readCard(quiet.page, 'np')).buttons).toEqual([]);
    } finally {
      await quiet.close();
    }
  }, SLOW);
});

describe('the editor (M6.9)', () => {
  it('previews a card chosen and not yet saved, from the speaker’s own words, and saves the look', async () => {
    await place([{ id: 'np', type: 'homeassistant', config: { readings: [PLAYER] }, y: 0.02, h: 0.18 }]);
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget[data-id="np"]', { timeout: 20_000 });
      await page.locator('.le-overlay .le-widget[data-id="np"]').click();
      await page.waitForSelector('.le-config', { timeout: 20_000 });
      // The Look is on the Style tab.
      await page.locator('.insp-tab', { hasText: 'Style' }).click();
      await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Now playing' }).click();
      // The server sends a track only beside a saved card, so the unsaved one
      // follows the speaker the editor marked, in its own words.
      const title = page.locator('.house-media .mp-title');
      await title.first().waitFor({ timeout: 10_000 });
      expect(await title.first().textContent()).toBe('Playing');
      // The sentence saying which speaker it follows, on this look alone.
      await page.locator('.insp-tab', { hasText: 'Content' }).click();
      await page.waitForTimeout(150);
      expect(await page.locator('.le-config [data-cfg-key="mediaFollows"]').count()).toBe(1);
      expect(await page.locator('.le-config [data-cfg-key="sparkline"]').count()).toBe(0);
      const saved = page.waitForEvent('load');
      await page.locator('[data-action="save"]').click();
      await saved;
      await expect
        .poll(() => {
          const row = wall.db
            .prepare(`SELECT config FROM layout_widgets WHERE id = 'np' AND orientation = 'portrait'`)
            .get() as { config: string } | undefined;
          return row === undefined ? undefined : JSON.parse(row.config);
        }, { timeout: 10_000 })
        .toMatchObject({ variant: 'media', readings: [PLAYER] });
      // Saved, the preview has the song.
      await page.waitForSelector('.le-overlay .le-widget[data-id="np"]', { timeout: 20_000 });
      await expect.poll(async () => page.locator('.house-media .mp-title').first().textContent(), { timeout: 10_000 }).toBe('Here Comes the Sun');
    } finally {
      await context.close();
    }
  }, SLOW);
});

describe('a card read from its own box', () => {
  it('trims a status card in a short box from the bottom, which it never did before (M6.8)', async () => {
    // The status card's belt looked for the card inside the card, so it never
    // ran; found by the now-playing card, which shares the pass.
    wall.db
      .prepare(
        `INSERT OR REPLACE INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, '19.4', '{"device_class":"temperature"}', 'Kitchen', '°C', ?, ?, 1, 'label_value', NULL, 5)`,
      )
      .run('sensor.kitchen', wall.now() - 60_000, wall.now());
    const config = { variant: 'status', subject: PLAYER, readings: [PLAYER, 'sensor.kitchen', 'binary_sensor.freezer_door'] };
    await place([{ id: 'st', type: 'homeassistant', config, y: 0.02, h: 0.05 }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const read = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('.fw[data-widget-id="st"]');
        const outer = box?.getBoundingClientRect();
        const details = [...(box?.querySelectorAll<HTMLElement>('.st-detail') ?? [])];
        return {
          stamped: box?.getAttribute('data-tier-items'),
          hidden: details.filter((d) => d.style.display === 'none').length,
          spill: details
            .filter((d) => d.style.display !== 'none')
            .some((d) => outer !== undefined && d.getBoundingClientRect().bottom > outer.bottom + 1),
        };
      });
      expect(read.stamped).not.toBeNull();
      expect(read.hidden).toBeGreaterThan(0);
      expect(read.spill).toBe(false);
    } finally {
      await close();
    }
  }, SLOW);
});

describe('the Notifications widget on a wall (M6.11)', () => {
  it('says a tile rule in the widget, not over the wall, and its OK acknowledges it', async () => {
    const rule = await wall.post('/admin/home-assistant/rules', {
      name: 'Freezer left open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'tile',
    });
    expect(rule.status).toBe(302);
    await place([
      { id: 'nf', type: 'notifications', config: { whenEmpty: { type: 'notes', config: { text: 'All quiet' } } }, y: 0.02, h: 0.12 },
    ]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const drawn = await page.evaluate(() => ({
        banners: document.querySelectorAll('.alert-banner, .alert-takeover, [data-dismiss]').length,
        title: document.querySelector('.fw[data-widget-id="nf"] .nf-title')?.textContent,
        detail: document.querySelector('.fw[data-widget-id="nf"] .nf-detail')?.textContent,
        ok: document.querySelector('.fw[data-widget-id="nf"] .nf-ok')?.getAttribute('data-tile-dismiss'),
      }));
      expect(drawn.banners).toBe(0);
      expect(drawn.title).toBe('Freezer left open');
      expect(drawn.detail).toBe('Freezer door · Open');
      expect(drawn.ok).toMatch(/^tile:[0-9a-f]{24}$/);
      await page.click('.fw[data-widget-id="nf"] .nf-ok');
      // Acknowledged, the widget has nothing to say and its fallback takes the box.
      await page.waitForFunction(
        () => document.querySelector('.fw[data-widget-id="nf"]')?.textContent?.includes('All quiet') === true,
        null,
        { timeout: 20_000 },
      );
    } finally {
      await close();
    }
  }, SLOW);
});

describe('clearing a Home Assistant notification from the wall (rule 12, amended 2026-10-14)', () => {
  it('draws a Clear behind the alert switch, and the press dismisses that one in Home Assistant', async () => {
    // Last in the file: it points the connection at a stand-in house.
    const ha = await fakeHomeAssistant();
    try {
      const connected = await wall.post('/admin/home-assistant/connect', {
        base_url: ha.base,
        token: TOKEN,
        allow_lan: '1',
        accept_http: '1',
      });
      expect(connected.status).toBe(302);
      const at = wall.now();
      ha.notifications.push(
        { notification_id: 'config_entry_discovery', title: 'New devices discovered', message: 'We found 2.', created_at: new Date(at).toISOString() },
        { notification_id: 'backup_failed', title: null, message: 'The backup failed.', created_at: new Date(at).toISOString() },
      );
      const insert = wall.db.prepare(
        `INSERT OR REPLACE INTO ha_notifications (notification_id, title, message, created_at, read_at) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('config_entry_discovery', 'New devices discovered', 'We found 2.', at - 60_000, at);
      insert.run('backup_failed', null, 'The backup failed.', at - 120_000, at);
      await place([{ id: 'nf', type: 'notifications', config: {}, y: 0.02, h: 0.12 }]);

      const { page, close } = await loadWallSettled(link, PORTRAIT);
      try {
        const before = await page.evaluate(() => ({
          clears: [...document.querySelectorAll('.fw[data-widget-id="nf"] [data-ha-notification-dismiss]')].map((b) => ({
            key: b.getAttribute('data-ha-notification-dismiss'),
            label: b.getAttribute('aria-label'),
            tag: b.tagName,
          })),
          page: document.documentElement.outerHTML,
        }));
        expect(before.clears).toHaveLength(2);
        for (const clear of before.clears) {
          expect(clear.tag).toBe('BUTTON');
          expect(clear.key).toMatch(/^han:[0-9a-f]{24}$/);
        }
        // Home Assistant's id never reaches the page.
        expect(before.page).not.toContain('config_entry_discovery');

        await page.click('.fw[data-widget-id="nf"] [aria-label="Clear: New devices discovered"]');
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.fw[data-widget-id="nf"] [data-ha-notification-dismiss]').length === 1 &&
            document.querySelector('.fw[data-widget-id="nf"]')?.textContent?.includes('New devices discovered') === false,
          null,
          { timeout: 20_000 },
        );
        expect(ha.posts.map((post) => [post.path, JSON.parse(post.body) as unknown])).toEqual([
          ['/api/services/persistent_notification/dismiss', { notification_id: 'config_entry_discovery' }],
        ]);
        expect(ha.notifications.map((one) => one.notification_id)).toEqual(['backup_failed']);
      } finally {
        await close();
      }

      // With the alert switch off, no Clear is drawn.
      wall.db.prepare('UPDATE screens SET allow_dismiss = 0 WHERE id = ?').run(screenId);
      const off = await loadWallSettled(link, PORTRAIT);
      try {
        expect(await off.page.locator('[data-ha-notification-dismiss]').count()).toBe(0);
        expect(await off.page.locator('.fw[data-widget-id="nf"]').textContent()).toContain('The backup failed.');
      } finally {
        await off.close();
      }
    } finally {
      await closeFakeHomeAssistants();
    }
  }, SLOW);
});
