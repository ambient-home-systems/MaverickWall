/**
 * A box shown only while the house says so (plan items M6.4, M6.5, M6.7), on
 * a real paired wall and in a real editor.
 *
 * The wall half is the one that only a browser can show: a pulse ends by the
 * wall's *own* clock, so the doorbell's box comes down on time with every
 * manifest request refused, draws its fallback in the same rectangle, and the
 * rectangle does not move. The editor half writes a rule through the control a
 * household uses, against a fake house answering as Home Assistant answers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

async function linkFor(wall: Installation, screenId: string): Promise<string> {
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  return found;
}

function place(wall: Installation, screenId: string, id: string, config: Record<string, unknown>, y: number): void {
  wall.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, 'portrait', 'notes', 0.05, ?, 0.4, 0.12, 100, ?, ?, ?)`,
    )
    .run(id, screenId, y, JSON.stringify(config), Date.now(), Date.now());
}

const boxOf = (page: Page, id: string) =>
  page.evaluate((widgetId) => {
    const el = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    if (el === null) return undefined;
    // As fractions of the canvas: cutting the server off puts the offline
    // banner up, which letterboxes the whole canvas a pixel or two — a fact
    // about the canvas and not about this box.
    const r = el.getBoundingClientRect();
    const c = (el.closest('.canvas') as HTMLElement).getBoundingClientRect();
    const f = (n: number): number => Math.round(n * 1000) / 1000;
    return {
      text: (el.textContent ?? '').trim(),
      x: f((r.x - c.x) / c.width),
      y: f((r.y - c.y) / c.height),
      w: f(r.width / c.width),
      h: f(r.height / c.height),
    };
  }, id);

describe('a box the house shows and hides', () => {
  it('comes down by the wall’s own clock, into its fallback, in the same rectangle, with the server cut off', async () => {
    const wall = await install();
    installations.push(wall);
    const screenId = await wall.pairWall('Kitchen');
    const link = await linkFor(wall, screenId);
    // The doorbell rang five seconds ago, by the wall's own clock.
    const now = wall.now();
    wall.db
      .prepare(`INSERT INTO ha_condition_states (entity_id, state, changed_at, read_at) VALUES (?, ?, ?, ?)`)
      .run('event.doorbell', new Date(now - 5_000).toISOString(), now - 5_000, now);
    wall.db
      .prepare(`INSERT INTO ha_condition_states (entity_id, state, changed_at, read_at) VALUES (?, ?, ?, ?)`)
      .run('binary_sensor.porch', 'off', now - 600_000, now);
    place(wall, screenId, 'bell', {
      text: 'Somebody rang the doorbell',
      showWhen: { entity: 'event.doorbell', pulse: 60 },
      whenEmpty: { type: 'notes', config: { text: 'All quiet at the door' } },
    }, 0.02);
    place(wall, screenId, 'porch', { text: 'Porch light on', showWhen: { entity: 'binary_sensor.porch', state: 'on' } }, 0.16);

    const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 }, { clock: 'installed' });
    try {
      const before = await boxOf(page, 'bell');
      expect(before?.text).toContain('Somebody rang the doorbell');
      // A box the house hides draws nothing at all, with no fallback named.
      expect(await boxOf(page, 'porch')).toBeUndefined();
      // Rule 12: the wall is told whether and until when, never by what.
      const html = await page.content();
      expect(html).not.toContain('event.doorbell');

      // Cut the wall off: what changes next is the wall's own clock.
      await page.route('**/d/manifest*', (route) => route.abort('connectionrefused'));
      await page.clock.runFor(30_000);
      expect((await boxOf(page, 'bell'))?.text).toContain('Somebody rang the doorbell');
      await page.clock.runFor(45_000);
      const after = await boxOf(page, 'bell');
      expect(after?.text).toContain('All quiet at the door');
      // Hidden is a substitution, never a moved rectangle.
      expect(after).toMatchObject({ x: before?.x, y: before?.y, w: before?.w, h: before?.h });
    } finally {
      await close();
    }
  }, SLOW);

  it('is set from the editor: an entity the house lists, the state that shows it, and what stands in', async () => {
    const wall = await install();
    installations.push(wall);
    const ha = await fakeHomeAssistant();
    ha.others['binary_sensor.porch'] = { state: 'off', name: 'Porch motion' };
    ha.others['event.doorbell'] = { state: '2026-10-12T11:00:00+00:00', name: 'Front doorbell' };
    await wall.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
    const screenId = await wall.pairWall('Kitchen');

    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
      const box = page.locator('.le-overlay .le-widget').first();
      const widgetId = await box.getAttribute('data-id');
      await box.click();
      const show = page.locator('.le-show-when');
      await show.getByRole('button', { name: 'While…', exact: true }).click();
      const entity = page.locator('.le-show-entity');
      await entity.waitFor({ timeout: 10_000 });
      // The house's entities by name, and an event only under "After…".
      const offered = await entity.locator('option').allTextContents();
      expect(offered).toContain('Porch motion (binary_sensor.porch)');
      expect(offered.some((one) => one.includes('event.doorbell'))).toBe(false);
      await entity.selectOption('binary_sensor.porch');
      await expect.poll(() => page.locator('.le-show-state').inputValue()).toBe('on');
      // A box sometimes hidden is offered what stands in for it.
      await expect.poll(() => page.locator('.le-fallback').textContent()).toContain('When this is hidden');

      await page.locator('[data-action="save"]').click();
      await expect
        .poll(() => {
          const row = wall.db
            .prepare(`SELECT config FROM layout_widgets WHERE id = ? AND orientation = 'portrait'`)
            .get(widgetId) as { config: string } | undefined;
          return row === undefined ? undefined : (JSON.parse(row.config) as Record<string, unknown>)['showWhen'];
        }, { timeout: 10_000 })
        .toEqual({ entity: 'binary_sensor.porch', state: 'on' });

      // "After…" offers the doorbell, and a pulse.
      if ((await show.count()) === 0) await page.locator(`.le-overlay .le-widget[data-id="${widgetId}"]`).click();
      await show.getByRole('button', { name: 'After…', exact: true }).click();
      await entity.waitFor();
      await entity.selectOption('event.doorbell');
      await expect.poll(() => page.locator('.le-show-pulse').inputValue()).toBe('60');
      expect(await page.locator('.le-show-state').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, SLOW);
});
