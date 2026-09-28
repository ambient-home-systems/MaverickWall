import { afterAll, beforeAll, it } from 'vitest';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import { SIZES, measureScreen, readForecastBox, setWeather, weatherWall, type WeatherWall } from './browser-weather-looks.js';

process.env['TZ'] = 'UTC';
const OUT = process.env['EXPLORE_OUT'] ?? '/tmp';
let ww: WeatherWall;
beforeAll(async () => {
  ww = await weatherWall({ hours: true, capture: (process.env['EXPLORE_CAPTURE'] as 'dc' | undefined) ?? 'london', fromDay: Number(process.env['EXPLORE_FROM'] ?? '0') });
}, 240_000);
afterAll(async () => {
  await ww?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

it('explores', async () => {
  const look = process.env['EXPLORE_LOOK'] ?? 'today';
  for (const preset of [undefined, 'tv-32']) {
    for (const size of SIZES) {
      measureScreen(ww, preset);
      for (const resize of [undefined, { h: 0.2 }, { h: 0.3 }, { w: 0.3, h: 0.12 }]) {
        await setWeather(ww, size.orientation, { variant: look }, resize);
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const id = ww.weather[size.orientation].id;
          const box = await readForecastBox(page, id);
          const extra = await page.evaluate((wid) => {
            const b = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${wid}"]`)!;
            const q = (sel: string): number | undefined => {
              const n = b.querySelector<HTMLElement>(sel);
              return n === null ? undefined : parseFloat(getComputedStyle(n).fontSize);
            };
            const r = b.getBoundingClientRect();
            const probe = document.createElement('span');
            probe.style.fontSize = 'var(--t-wall-lede, var(--t-event))';
            b.appendChild(probe);
            const ledeRole = parseFloat(getComputedStyle(probe).fontSize);
            probe.remove();
            return {
              box: [Math.round(r.width), Math.round(r.height)],
              next: b.getAttribute('data-next'),
              advice: b.getAttribute('data-advice'),
              lede: q('.wt-head'),
              ledeRole,
              cond: q('.wt-cond'),
              name: q('.wp-name'),
              temp: q('.wp-temp'),
              text: b.innerText.replace(/\s+/g, ' ').slice(0, 120),
              costs: (() => {
                const em = parseFloat(getComputedStyle(b.querySelector('.wt-cond, .wp-temp, .wp-name, .wt-top') as HTMLElement).fontSize);
                const out: Record<string, number> = { em };
                const h = (sel: string): void => {
                  const n = b.querySelector<HTMLElement>(sel);
                  if (n === null) return;
                  const st = getComputedStyle(n);
                  out[sel] = Math.round(((n.offsetHeight + parseFloat(st.marginTop) + parseFloat(st.marginBottom)) / em) * 100) / 100;
                };
                for (const sel of ['.wx-today', '.wt-head', '.wt-range', '.wt-cond', '.wt-feels', '.wt-next', '.wx-playful', '.wp-name', '.wp-emoji', '.wp-temp', '.wp-advice']) h(sel);
                const sec = b.querySelector<HTMLElement>('.wx-today, .wx-playful');
                if (sec) { const st = getComputedStyle(sec); out['padY'] = Math.round(((parseFloat(st.paddingTop) + parseFloat(st.paddingBottom)) / em) * 100) / 100; }
                const probe = document.createElement('span'); probe.className = 'wt-cond'; probe.textContent = 'Mostly clear'; probe.style.position='absolute';
                (b.querySelector('.wt-top') ?? b).appendChild(probe); out['chMostly'] = probe.offsetWidth; probe.remove();
                return out;
              })(),
            };
          }, id);
          const tag = `${look}-${preset ?? 'unmeasured'}-${size.width}x${size.height}-${resize === undefined ? 'seed' : JSON.stringify(resize).replace(/[^a-z0-9.]/gi, '')}`;
          console.log(tag, JSON.stringify({ tier: box.tier, rungs: box.rungs, items: box.items, belted: box.belted, clipped: box.clipped, ...extra }));
          const handle = await page.$(`#wall .canvas .fw[data-widget-id="${id}"]`);
          await handle?.screenshot({ path: `${OUT}/${tag}.png` });
        } finally {
          await close();
        }
      }
    }
  }
}, 900_000);
