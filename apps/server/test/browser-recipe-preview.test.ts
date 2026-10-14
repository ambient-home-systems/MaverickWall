/**
 * A recipe's preview on the recipe page (plan item M7.10), in a real browser.
 *
 * What only a browser can say: that the panel the server built from a pasted
 * answer is drawn by the wall's own renderer, in the house's theme, in two
 * boxes that each choose their own form; that nothing is asked of the recipe's
 * address and nothing is installed; and that a recipe the wall cannot draw
 * says where, on the page an author is standing at.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 120_000;
const installations: Installation[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const RECIPE = {
  name: 'Bins',
  contract: 1,
  fetch: { url: 'https://bins.example.invalid/v1/collections' },
  panel: {
    kind: 'readings',
    title: '{council}',
    items: { for: 'collections', label: '{kind}', value: '{day}' },
  },
};
const ANSWER = {
  council: 'Riverside Council',
  collections: [
    { kind: 'Recycling', day: 'Tomorrow' },
    { kind: 'General waste', day: 'Monday' },
    { kind: 'Garden', day: 'Wednesday' },
    { kind: 'Food', day: 'Thursday' },
    { kind: 'Glass', day: 'Friday' },
    { kind: 'Textiles', day: 'Saturday' },
  ],
};

interface Drawn {
  readonly drawn: boolean;
  readonly title: string;
  readonly shown: string[];
  readonly overflow: number;
  readonly ground: string;
}

describe('the recipe page’s preview', () => {
  it('draws the panel the recipe builds from a pasted answer, in two boxes, and asks the address nothing', async () => {
    const wall = await install();
    installations.push(wall);
    // The recipe's address is a real server, so asking it would be counted.
    let feedAsked = 0;
    const feed = createServer((_request, response) => {
      feedAsked += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(ANSWER));
    });
    servers.push(feed);
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    const port = (feed.address() as { port: number }).port;
    const recipe = { ...RECIPE, fetch: { url: `http://127.0.0.1:${port}/v1/collections`, allowLan: true } };
    const context = await (await browser()).newContext({ viewport: { width: 1280, height: 1000 } });
    try {
      const page = await context.newPage();
      const asked: string[] = [];
      page.on('request', (request) => asked.push(request.url()));
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/modules/recipe`, { waitUntil: 'load' });
      await page.locator('textarea[name="manifest"]').fill(JSON.stringify(recipe, null, 2));
      await page.locator('textarea[name="answer"]').fill(JSON.stringify(ANSWER));
      await Promise.all([page.waitForURL(/\/admin\/modules\/recipe\/preview$/), page.getByRole('button', { name: 'Preview' }).click()]);
      await page.locator('[data-recipe-preview][data-drawn="true"]').nth(1).waitFor({ timeout: 20_000 });

      const drawn = await page.evaluate((): Record<string, Drawn> => {
        const out: Record<string, Drawn> = {};
        for (const mount of Array.from(document.querySelectorAll<HTMLElement>('[data-recipe-preview]'))) {
          const root = mount.shadowRoot;
          const box = mount.getBoundingClientRect();
          const rows = Array.from(root?.querySelectorAll<HTMLElement>('.gp-reading') ?? []);
          const shown = rows
            .filter((row) => {
              const style = getComputedStyle(row);
              const rect = row.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0 && rect.bottom <= box.bottom + 0.5;
            })
            .map((row) => row.querySelector('.gp-label')?.textContent ?? '');
          // How far the drawn rows reach past the box an author is shown: none.
          const overflow = Math.max(
            0,
            ...rows
              .filter((row) => getComputedStyle(row).visibility !== 'hidden' && getComputedStyle(row).display !== 'none')
              .map((row) => row.getBoundingClientRect().bottom - box.bottom),
          );
          const wallRoot = root?.querySelector<HTMLElement>('.preview-wall') ?? null;
          out[mount.dataset['recipePreview'] ?? ''] = {
            drawn: mount.dataset['drawn'] === 'true',
            title: root?.querySelector('.gp-title')?.textContent ?? '',
            shown,
            overflow,
            ground: wallRoot === null ? '' : getComputedStyle(wallRoot).getPropertyValue('--bg').trim(),
          };
        }
        return out;
      });

      const third = drawn['third'];
      const strip = drawn['strip'];
      expect(third?.drawn).toBe(true);
      expect(strip?.drawn).toBe(true);
      expect(third?.title).toBe('Riverside Council');
      // The wall's own renderer, in order, and a box that reads itself: the
      // strip gives up rows the third keeps, and neither draws past its foot.
      expect(third?.shown.slice(0, 2)).toEqual(['Recycling', 'General waste']);
      expect(third?.shown.length ?? 0).toBeGreaterThan(strip?.shown.length ?? 0);
      expect(strip?.shown.length ?? 0).toBeGreaterThan(0);
      expect(third?.overflow).toBe(0);
      expect(strip?.overflow).toBe(0);
      // In the house's own theme: a household with no wall yet is drawn in Panels.
      expect(third?.ground.toLowerCase()).toBe(BUILTIN_THEME_TOKENS.panels['--bg'].toLowerCase());

      // Nothing went to the recipe's address, from the page or the server, and nothing was installed.
      expect(asked.some((url) => url.includes(`:${port}/`))).toBe(false);
      expect(feedAsked).toBe(0);
      expect((wall.db.prepare('SELECT COUNT(*) AS n FROM external_modules').get() as { n: number }).n).toBe(0);

      // The page keeps what was typed, so Add recipe installs what was previewed.
      expect(JSON.parse(await page.locator('textarea[name="manifest"]').inputValue())).toEqual(recipe);
      expect(JSON.parse(await page.locator('textarea[name="answer"]').inputValue())).toEqual(ANSWER);
      await Promise.all([page.waitForURL(/\/admin\/modules(\?|$)/), page.getByRole('button', { name: 'Add recipe' }).click()]);
      expect((wall.db.prepare('SELECT name FROM external_modules').get() as { name: string }).name).toBe('Bins');
    } finally {
      await context.close();
    }
  }, SLOW);

  it('says where the wall’s schema refused a panel, and draws nothing', async () => {
    const wall = await install();
    installations.push(wall);
    const context = await (await browser()).newContext({ viewport: { width: 1280, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/modules/recipe`, { waitUntil: 'load' });
      await page.locator('textarea[name="manifest"]').fill(JSON.stringify(RECIPE));
      const long = { council: 'Riverside', collections: [{ kind: 'x'.repeat(61), day: 'Monday' }] };
      await page.locator('textarea[name="answer"]').fill(JSON.stringify(long));
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/admin/modules/recipe/preview')),
        page.getByRole('button', { name: 'Preview' }).click(),
      ]);
      expect(response.status()).toBe(400);
      await page.locator('#preview').waitFor();
      const preview = await page.locator('#preview').innerText();
      expect(preview).toContain('The recipe ran, and the wall cannot draw what it built.');
      expect(await page.locator('[data-preview-detail]').innerText()).toMatch(/^panel\.items\.0\.label: /);
      expect(await page.locator('[data-recipe-preview]').count()).toBe(0);
      expect(await page.locator('script[src="assets/recipe-preview.js"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, SLOW);
});
