import { afterAll, describe, expect, it } from 'vitest';
import { browser, install, settleWall, shutDownBrowser } from './browser-harness.js';

/**
 * Three calendars, three colours, measured on a real wall.
 *
 * `palette.test.ts` proves the rotation writes distinct hexes into SQLite. This
 * asks the only question that actually matters: does a household looking at the
 * wall see three different things? Every colour below is read back as a
 * **computed** background or border, never as a class or a custom property —
 * this project has shipped a bug where the class was applied and the pixels
 * were wrong (the chore tick's empty box), and `--pc` on an element proves the
 * renderer set a variable, not that anything was painted with it.
 *
 * The calendars are added through the real `POST /admin/calendars` form, which
 * is what the report did ("added three calendars through the UI"), and synced
 * through the real job. Nothing here inserts a row or a colour by hand.
 */

afterAll(async () => {
  await shutDownBrowser();
});

/** `rgb(76, 127, 209)` → `#4C7FD1`, so a failure names a colour a person knows. */
function toHex(computed: string): string {
  const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  if (parts === null) return computed;
  return `#${[1, 2, 3]
    .map((i) => Number(parts[i]).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

interface Pill {
  readonly background: string;
  readonly border: string;
  readonly truncated: boolean;
  readonly text: string;
}

async function threeCalendarWall(): Promise<{
  stored: { name: string; color: string }[];
  pills: Pill[];
  dispose: () => Promise<void>;
}> {
  const home = await install({ wizard: true, feed: true });
  // The wizard added "Family". Two more through the admin form, the same feed
  // behind each — the addresses are not what is under test, the colours are.
  const url = home.feedUrl;
  if (url === undefined) throw new Error('the harness served no feed');
  for (const name of ['School', 'Work']) {
    const added = await home.post('/admin/calendars', {
      name,
      url,
      action: 'add',
      allow_loopback: '1',
      allow_http: '1',
    });
    if (added.status !== 302) {
      throw new Error(`the admin form refused ${name} (${added.status}): ${await added.text()}`);
    }
  }
  await home.sync();

  const stored = home.db
    .prepare('SELECT name, color FROM calendar_sources ORDER BY created_at, rowid')
    .all() as { name: string; color: string }[];

  const page = await (await browser()).newPage();
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.goto(await home.pairLink(), { waitUntil: 'load' });
  await settleWall(page);

  const pills = await page.evaluate(() => {
    const out: {
      background: string;
      border: string;
      truncated: boolean;
      text: string;
    }[] = [];
    document.querySelectorAll('.hz-pill').forEach((node) => {
      const el = node as HTMLElement;
      if (el.classList.contains('hz-pill-more')) return;
      const style = getComputedStyle(el);
      out.push({
        background: style.backgroundColor,
        border: style.borderLeftColor,
        // The stakes, measured rather than assumed: a pill whose own title does
        // not fit inside it.
        truncated: el.scrollWidth > el.clientWidth,
        text: el.textContent ?? '',
      });
    });
    return out;
  });

  return {
    stored,
    pills,
    dispose: async (): Promise<void> => {
      await page.close();
      await home.dispose();
    },
  };
}

describe('three calendars on a real wall', () => {
  it('draws them in three different colours, and one of them is not blue', async () => {
    const wall = await threeCalendarWall();
    try {
      expect(wall.stored.map((row) => row.name)).toEqual(['Family', 'School', 'Work']);
      expect(new Set(wall.stored.map((row) => row.color.toUpperCase())).size).toBe(3);

      expect(wall.pills.length).toBeGreaterThan(0);

      // A solid pill paints its background; an all-day one paints its left
      // border instead and leaves the background transparent. Either way the
      // calendar's colour is the one visibly on the glass.
      const drawn = new Set(
        wall.pills.map((pill) =>
          toHex(pill.background === 'rgba(0, 0, 0, 0)' ? pill.border : pill.background),
        ),
      );
      expect([...drawn].sort()).toEqual(
        [...wall.stored.map((row) => row.color.toUpperCase())].sort(),
      );
    } finally {
      await wall.dispose();
    }
  }, 120_000);

  it('keeps a truncated pill telling you whose it is', async () => {
    // Why this bug matters more than it looks: the month grid cuts titles off,
    // so a pill reading "School trip to the aq…" carries no information at all
    // unless its colour differs from the one under it. This measures a pill
    // that really is clipped and asserts its colour is not the only one on the
    // wall.
    const wall = await threeCalendarWall();
    try {
      const clipped = wall.pills.filter((pill) => pill.truncated);
      expect(clipped.length, 'no pill was clipped, so this proves nothing').toBeGreaterThan(0);

      const clippedColours = new Set(
        clipped.map((pill) =>
          toHex(pill.background === 'rgba(0, 0, 0, 0)' ? pill.border : pill.background),
        ),
      );
      expect(clippedColours.size).toBeGreaterThan(1);
    } finally {
      await wall.dispose();
    }
  }, 120_000);
});
