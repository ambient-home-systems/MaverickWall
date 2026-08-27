/**
 * Every word on the page, measured against the pixels behind it (WCAG 1.4.3).
 *
 * `design-tokens.test.ts` asks the same question of the *stylesheet* — for
 * every rule, what does it paint on what — and that derivation is deliberately
 * pessimistic: a rule that sets only a `color` has an unknown ground, so it is
 * held against all four. That is the right trade for a static check and it is
 * not the browser's answer. The browser knows which ground each run of text
 * actually landed on, knows what an inherited colour resolved to, and knows
 * that `.sub .host` sits inside a sentence rather than on a card.
 *
 * So this is the other half. It walks the rendered document, composites each
 * text node's real background out of its ancestors, and holds the pair to the
 * ratio WCAG asks for at that size and weight.
 *
 * It exists because of what it was written to confirm. `.host` was one class
 * doing two jobs — a hostname class that had become the generic second line —
 * and it carried `ink-3`, 3.25:1 in the light scheme, to most of the product's
 * secondary information layer: the alert ladder's explanations, "Last seen 2
 * minutes ago", the nav group heads, and the wizard's own field placeholders.
 * Every one of those is on one of the three pages below, in both schemes.
 *
 * The three exemptions are WCAG's own and each is stated where it is taken.
 * There is no allow-list of failing elements: an exemption that has to name a
 * selector is a failure being written down rather than fixed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 90_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  // With a real feed, so `/admin/calendars` renders a source row — which is
  // the only page below that still carries `.host`, the machine-identity half
  // of the split this file was written for.
  const made = await install({ feed: true });
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

interface Finding {
  readonly where: string;
  readonly text: string;
  readonly color: string;
  readonly ground: string;
  readonly size: number;
  readonly weight: number;
  readonly ratio: number;
  readonly needs: number;
}

interface Reading {
  readonly findings: readonly Finding[];
  /** How many runs were actually measured — a walker that stops finding text
   *  passes over everything, which is the failure mode of the thing it checks. */
  readonly measured: number;
  /** Runs whose ground could not be resolved (an image or a gradient behind
   *  them). Reported rather than silently skipped. */
  readonly unresolved: readonly string[];
  /** How many runs each half of the split contributed. Both have to be more
   *  than nothing across the four pages, or this file is grading one class and
   *  reporting a pass for two. */
  readonly hosts: number;
  readonly subs: number;
}

/**
 * Walk the rendered page and grade every run of text.
 *
 * Written as one string evaluated in the page rather than as several round
 * trips, because a composited background has to be read while the layout it
 * came from is still standing.
 */
async function readContrast(page: Page): Promise<Reading> {
  return await page.evaluate(() => {
    const findings: {
      where: string; text: string; color: string; ground: string;
      size: number; weight: number; ratio: number; needs: number;
    }[] = [];
    const unresolved: string[] = [];
    let measured = 0;
    let hosts = 0;
    let subs = 0;

    const parse = (value: string): [number, number, number, number] | null => {
      const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
      if (m === null) return null;
      const parts = (m[1] as string).split(/[,\s/]+/).filter((p) => p !== '');
      const n = parts.map(Number);
      if (n.length < 3 || n.slice(0, 3).some((v) => Number.isNaN(v))) return null;
      return [n[0] as number, n[1] as number, n[2] as number, n.length > 3 ? (n[3] as number) : 1];
    };

    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number, number],
    ): [number, number, number, number] => {
      const a = top[3];
      return [
        top[0] * a + bottom[0] * (1 - a),
        top[1] * a + bottom[1] * (1 - a),
        top[2] * a + bottom[2] * (1 - a),
        1,
      ];
    };

    const lum = (c: [number, number, number, number]): number => {
      const ch = (raw: number): number => {
        const v = raw / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    };

    const ratio = (
      ink: [number, number, number, number],
      ground: [number, number, number, number],
    ): number => {
      const [a, b] = [lum(ink), lum(ground)];
      const [hi, lo] = a >= b ? [a, b] : [b, a];
      return (hi + 0.05) / (lo + 0.05);
    };

    /** The composited ground behind an element, or null if an image is in the way. */
    const groundOf = (el: Element): [number, number, number, number] | null => {
      let stack: [number, number, number, number] = [0, 0, 0, 0];
      let node: Element | null = el;
      while (node !== null) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none') return null;
        const layer = parse(style.backgroundColor);
        if (layer !== null && layer[3] > 0) {
          stack = stack[3] === 0 ? layer : over(stack, layer);
          if (stack[3] >= 0.999) return stack;
        }
        node = node.parentElement;
      }
      // Nothing opaque all the way up: the canvas is the html background, and
      // if that too is transparent the browser paints white.
      const root = parse(getComputedStyle(document.documentElement).backgroundColor);
      const base: [number, number, number, number] =
        root !== null && root[3] > 0 ? [root[0], root[1], root[2], 1] : [255, 255, 255, 1];
      return stack[3] === 0 ? base : over(stack, base);
    };

    const where = (el: Element): string => {
      const cls = typeof el.className === 'string' && el.className !== ''
        ? '.' + el.className.trim().split(/\s+/).join('.')
        : '';
      return `${el.tagName.toLowerCase()}${cls}`;
    };

    /** WCAG's large-text threshold: 18pt, or 14pt bold. */
    const barFor = (size: number, weight: number): number =>
      size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

    const grade = (
      el: Element,
      text: string,
      ink: [number, number, number, number],
      size: number,
      weight: number,
      label: string,
    ): void => {
      const ground = groundOf(el);
      if (ground === null) {
        unresolved.push(`${where(el)} ${label}`);
        return;
      }
      measured += 1;
      if (el.classList.contains('host')) hosts += 1;
      if (el.classList.contains('sub')) subs += 1;
      const needs = barFor(size, weight);
      const got = ratio(ink, ground);
      if (got >= needs) return;
      findings.push({
        where: where(el) + label,
        text: text.slice(0, 48),
        color: `rgb(${ink.slice(0, 3).map(Math.round).join(',')})`,
        ground: `rgb(${ground.slice(0, 3).map(Math.round).join(',')})`,
        size,
        weight,
        ratio: Math.round(got * 100) / 100,
        needs,
      });
    };

    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // A fully transparent element paints nothing; a partly transparent one
      // is measured at its face value, which is the conservative reading.
      if (Number(style.opacity) === 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;

      // Only the element's OWN text, so a paragraph's colour is not credited
      // to the section that contains it.
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent ?? '').trim())
        .join(' ')
        .trim();

      if (own !== '') {
        // WCAG 1.4.3 exempts text in an inactive user-interface component.
        const disabled = (el as HTMLInputElement).disabled === true
          || el.closest('[disabled]') !== null
          || el.closest('fieldset[disabled]') !== null;
        // …and "incidental" text: a decorative glyph that repeats a label. The
        // only ones here are the separator dots and chevrons drawn as content.
        const incidental = /^[·•‹›<>«»…←-⇿─-◿]+$/.test(own);
        const ink = parse(style.color);
        if (!disabled && !incidental && ink !== null && ink[3] > 0) {
          grade(el, own, ink[3] < 1 ? ink : ink, size, weight, '');
        }
      }

      // Placeholders are text a person reads to learn the expected format
      // ("e.g. 38.8894"), and they are drawn by a pseudo-element the walk above
      // cannot see.
      const placeholder = (el as HTMLInputElement).placeholder;
      if (typeof placeholder === 'string' && placeholder !== '') {
        const pseudo = getComputedStyle(el, '::placeholder');
        const ink = parse(pseudo.color);
        if (ink !== null && ink[3] > 0) {
          grade(el, placeholder, ink, parseFloat(pseudo.fontSize) || size,
            Number(pseudo.fontWeight) || weight, ' ::placeholder');
        }
      }
    }

    return { findings, measured, unresolved, hosts, subs };
  });
}

/**
 * The scheme is chosen *before* the first navigation, not flipped afterwards.
 *
 * The admin's toggle writes `localStorage` and a tiny inline script re-applies
 * it on the next parse, so a household who has chosen a theme loads every page
 * already in it. Flipping `data-theme` on a live document is a different thing
 * and it reads wrong: `html.ts` transitions the big surfaces on a scheme
 * change, so a measurement taken straight afterwards catches the page a third
 * of the way there — measured, body came back `rgb(218,217,216)`, which is a
 * colour neither scheme contains and which no amount of contrast arithmetic
 * over it would mean anything.
 */
async function schemeContext(home: Installation, scheme: 'light' | 'dark'): Promise<Page> {
  const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((value) => {
    try {
      localStorage.setItem('mw-admin-theme', value as string);
    } catch {
      /* a context with storage disabled would fall back to the media query */
    }
  }, scheme);
  const page = await ctx.newPage();
  await home.signIn(page);
  return page;
}

const PAGES = ['/admin/alerts', '/admin/walls', '/admin/system', '/admin/calendars'] as const;
const SCHEMES = ['light', 'dark'] as const;

describe('the admin, read at its own contrast', () => {
  it.each(SCHEMES)(
    'clears WCAG AA on every run of text in the %s scheme',
    async (scheme) => {
      const home = await fresh();
      const page = await schemeContext(home, scheme);

      const failures: string[] = [];
      let total = 0;
      let hosts = 0;
      let subs = 0;
      for (const path of PAGES) {
        await page.goto(`${home.base}${path}`, { waitUntil: 'load' });
        // The scheme has to be the one asked for, or this whole file grades
        // one palette twice and reports it as two passes.
        const applied = await page.evaluate(() => ({
          attr: document.documentElement.getAttribute('data-theme'),
          bg: getComputedStyle(document.body).backgroundColor,
        }));
        expect(applied.attr, `${path} did not load in the ${scheme} scheme`).toBe(scheme);
        expect(
          applied.bg,
          `${path}: the body ground is ${applied.bg}, which is not ${scheme}`,
        ).toBe(scheme === 'dark' ? 'rgb(20, 22, 26)' : 'rgb(247, 246, 244)');

        const reading = await readContrast(page);
        total += reading.measured;
        hosts += reading.hosts;
        subs += reading.subs;
        expect(
          reading.measured,
          `${path} yielded no measurable text at all — the walker is broken, not the page`,
        ).toBeGreaterThan(20);
        for (const f of reading.findings) {
          failures.push(
            `${path} ${f.where} ${f.ratio}:1 (needs ${f.needs}) ` +
              `${f.color} on ${f.ground} at ${f.size}px/${f.weight} — “${f.text}”`,
          );
        }
        // An unresolved ground is a hole in the measurement, not a pass.
        expect(
          reading.unresolved,
          `${path}: an image or gradient sits behind text, so its contrast was never checked`,
        ).toEqual([]);
      }

      expect(total, 'too little text measured across four pages').toBeGreaterThan(150);
      // The split is the change under test, so both halves have to be on
      // screen. A page set that renders only prose would pass this file with
      // .host never drawn and its colour never read.
      expect({ hosts: hosts > 0, subs: subs > 0 }, `.host x${hosts}, .sub x${subs}`)
        .toEqual({ hosts: true, subs: true });
      expect(
        failures,
        `${failures.length} runs of text below their AA bar in the ${scheme} scheme:\n` +
          failures.map((line) => `  ${line}`).join('\n'),
      ).toEqual([]);

      await page.context().close();
    },
    SLOW,
  );
});
