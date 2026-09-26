import {
  CELEBRATION_EMOJI,
  CELEBRATION_EVERY_MS,
  CELEBRATION_MS,
  FIREWORK_BURSTS,
  FLAP_FALL_MS,
  OCCASION_LOOKS,
  OCCASION_SCENE_MS,
  PAGE_TEAR_MS,
  PROGRESS_FILL_MS,
  SCENE_SPOTS,
  SPARKS,
  TODAY_WORDS,
  WAVE_BAND_MS,
  celebrates,
  confettiPieces,
  countDigits,
  countdownEmoji,
  countdownFrom,
  countdownLabel,
  countdownOccasion,
  countdownProgress,
  countdownTarget,
  countdownWords,
  daysUntil,
  miniMonth,
  monthTitleWords,
  percentWords,
  previousDigits,
  sparkReach,
  targetDateWords,
  ticketLine,
  todayInMonth,
  unitWords,
  weekdayHeads,
  type OccasionScene,
} from './countdown.js';
import { emojiNode, type EmojiKey } from './emoji.js';
import { changedAt, lockLoop, lockOnce, oneShotPhase, repeatFiredAt, type OneShotMemory } from './motion.js';
import { variantOf } from './variants.js';
import { DISPLAY_LOCALE, localDate } from './viewmodel.js';

/**
 * A countdown on the wall, in each of its designed looks (plan item P5.2).
 *
 * All six are drawn here: `number` (the countdown every wall has drawn, which
 * gains a picture and "sleeps"), `page` (a tear-off calendar page), `ticket`
 * (a boarding pass), `occasion` (the number dressed for Christmas, a birthday
 * and the rest, with a scene that moves), `progress` (a bar of the days gone
 * since a start date) and `month` (a small month with the target circled).
 *
 * **`number` with no new keys is the same nodes, the same classes and the
 * same words it was on every day but its target**, and that is asserted by
 * rendering rather than argued (`browser-countdown-number`). On the day it
 * says "Today!" with a party popper, which is the plan's celebration and the
 * one thing a countdown nobody touched does differently.
 *
 * What moves — the confetti, a page tearing off at midnight, a flap falling
 * on the board — goes through `motion.ts`, the one door; this file names the
 * classes the scoped block in `display.css` keys its keyframes on, and asks
 * the per-widget memory when each one fired.
 */

/** The facts every look draws from, read once. */
interface Countdown {
  readonly widgetId: string;
  readonly now: number;
  readonly memory: OneShotMemory;
  readonly target: string;
  readonly today: string;
  readonly days: number;
  readonly words: ReturnType<typeof countdownWords>;
  readonly label: string;
  readonly emoji: ReturnType<typeof countdownEmoji>;
}

/** The slice of the wall's model a countdown reads. */
export interface CountdownModel {
  readonly now: number;
  readonly timezone: string;
  /** The household's first day of the week, for a mini month. */
  readonly weekStart: 'sunday' | 'monday';
  readonly oneShots: OneShotMemory;
}

/** The section's class for each look; `number`'s is the one it always had. */
const LOOK_CLASS: Readonly<Record<string, string>> = {
  page: 'cd cd-page',
  ticket: 'cd cd-ticket',
  occasion: 'cd cd-occasion',
  progress: 'cd cd-progress',
  month: 'cd cd-month',
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A node that names which rung of its look it is, for the tier pass. */
function part(tag: string, className: string, name: string, text?: string): HTMLElement {
  const node = el(tag, className, text);
  node.dataset['part'] = name;
  return node;
}

/**
 * Draw a countdown.
 *
 * `model.now` is the *server's* time, not the tablet's, so a countdown does not
 * drift with a screen whose clock is two hours out. A date not yet set says so
 * rather than drawing a bare zero, on every look.
 */
export function renderCountdown(model: CountdownModel, config: unknown, widgetId: string): HTMLElement {
  const target = countdownTarget(config);
  const look = variantOf('countdown', config);
  const box = el('section', LOOK_CLASS[look] ?? 'cd');
  if (target === undefined) {
    box.appendChild(el('div', 'cd-empty', 'Set a date in this widget’s options.'));
    return box;
  }
  const today = localDate(model.now, model.timezone);
  const facts: Countdown = {
    widgetId,
    now: model.now,
    memory: model.oneShots,
    target,
    today,
    days: daysUntil(today, target),
    words: countdownWords(config),
    label: countdownLabel(config),
    emoji: countdownEmoji(config),
  };
  if (look === 'page') drawPage(box, facts);
  else if (look === 'ticket') drawTicket(box, facts);
  else if (look === 'occasion') drawOccasion(box, facts, config);
  else if (look === 'progress') drawProgress(box, facts, config);
  else if (look === 'month') drawMonth(box, facts, model.weekStart);
  else drawNumber(box, facts);
  if (facts.days === 0 && celebrates(config)) drawConfetti(box, facts);
  return box;
}

/** "Today!" and its popper: what every look says on the day. */
function todayWords(node: HTMLElement): HTMLElement {
  node.appendChild(document.createTextNode(TODAY_WORDS));
  const popper = emojiNode(CELEBRATION_EMOJI, 'cd-emoji cd-emoji-today');
  if (popper !== null) node.appendChild(popper);
  return node;
}

/**
 * The household's label with its picture in front, or `undefined` for a
 * countdown with neither. The picture goes with the title because it says
 * what the title says — "Christmas" with a tree — rather than decorating the
 * number, which would put a picture between a count and its unit.
 */
function labelNode(className: string, facts: Countdown, partName?: string): HTMLElement | undefined {
  if (facts.label === '' && facts.emoji === undefined) return undefined;
  const node = partName === undefined ? el('div', className) : part('div', className, partName);
  const picture = facts.emoji === undefined ? null : emojiNode(facts.emoji, 'cd-emoji');
  if (picture !== null) node.appendChild(picture);
  if (facts.label !== '') node.appendChild(document.createTextNode(facts.label));
  return node;
}

/**
 * The number: a count, its unit and the label, sized to the box by
 * `--buw`/`--buh` exactly as before.
 *
 * The label is a text-only `div` when there is no picture — the node it has
 * always been — so a countdown nobody gave a picture to is the same DOM.
 */
function drawNumber(box: HTMLElement, facts: Countdown): void {
  if (facts.days === 0) {
    box.appendChild(todayWords(el('div', 'cd-num')));
  } else {
    box.appendChild(el('div', 'cd-num', countDigits(facts.days)));
    box.appendChild(el('div', 'cd-unit', unitWords(facts.days, facts.words)));
  }
  if (facts.emoji === undefined) {
    if (facts.label !== '') box.appendChild(el('div', 'cd-label', facts.label));
  } else {
    const label = labelNode('cd-label', facts);
    if (label !== undefined) box.appendChild(label);
  }
}

/**
 * A tear-off calendar page: a binder strip, the count large, its unit, and the
 * target's own date at the foot of the sheet; the label under it.
 *
 * **The page tears off once, at midnight**, when the count changes — a leaf
 * carrying yesterday's count lifts away over today's. `changedAt` is what
 * makes it "when the count changes" rather than "whenever the page is drawn":
 * a wall reloaded at noon has not seen a page go, so it draws none going.
 * Keyed on the civil date, so a household editing the target is not shown a
 * page tearing off for a day that did not pass.
 */
function drawPage(box: HTMLElement, facts: Countdown): void {
  const sheet = el('div', 'cdp-sheet');
  const binder = el('div', 'cdp-binder');
  binder.setAttribute('aria-hidden', 'true');
  sheet.appendChild(binder);

  const num = part('div', 'cdp-num', 'num');
  if (facts.days === 0) {
    todayWords(num);
    num.style.setProperty('--cd-chars', String(TODAY_WORDS.length + 1));
  } else {
    num.textContent = countDigits(facts.days);
    num.style.setProperty('--cd-chars', String(countDigits(facts.days).length));
  }
  sheet.appendChild(num);
  const unit = unitWords(facts.days, facts.words);
  if (unit !== '') sheet.appendChild(part('div', 'cdp-unit', 'unit', unit));
  sheet.appendChild(part('div', 'cdp-date', 'date', targetDateWords(facts.target, DISPLAY_LOCALE)));

  const torn = changedAt(facts.memory, facts.widgetId, 'page', facts.today, facts.now);
  const leaf = el('div', 'cdp-leaf');
  leaf.setAttribute('aria-hidden', 'true');
  if (lockOnce(leaf, PAGE_TEAR_MS, oneShotPhase(torn, PAGE_TEAR_MS, facts.now))) {
    const before = facts.days + 1;
    const oldNum = el('div', 'cdp-num', before === 0 ? TODAY_WORDS : countDigits(before));
    oldNum.style.setProperty('--cd-chars', String((before === 0 ? TODAY_WORDS : countDigits(before)).length));
    leaf.appendChild(el('div', 'cdp-binder'));
    leaf.appendChild(oldNum);
    sheet.appendChild(leaf);
  }
  box.appendChild(sheet);

  const label = labelNode('cdp-label', facts, 'label');
  if (label !== undefined) box.appendChild(label);
}

/**
 * A boarding pass: a head, the destination (the household's label) large, the
 * line "Departs in 12 days", a perforated rule, and the count on a departure
 * board.
 *
 * **A flap falls only when its digit changes.** At midnight 12 becomes 11:
 * the tens stays where it is and the units flap falls, carrying the old digit
 * away over the new one — a board that turned every flap would be saying
 * every digit changed. On the day there is nothing to count, so the line says
 * "Today!" and the board is not drawn.
 */
function drawTicket(box: HTMLElement, facts: Countdown): void {
  const pass = el('div', 'cdt-pass');
  pass.appendChild(part('div', 'cdt-head', 'head', 'Boarding pass'));
  const dest = labelNode('cdt-dest', facts, 'dest');
  if (dest !== undefined) pass.appendChild(dest);

  const when = part('div', 'cdt-when', 'when');
  if (facts.days === 0) todayWords(when);
  else when.textContent = ticketLine(facts.days, facts.words);
  pass.appendChild(when);

  if (facts.days !== 0) {
    const board = part('div', 'cdt-board', 'board');
    const digits = countDigits(facts.days).split('');
    const turned = changedAt(facts.memory, facts.widgetId, 'board', facts.today, facts.now);
    const old = previousDigits(facts.days, digits.length);
    digits.forEach((digit, index) => {
      const flap = el('span', 'cdt-flap', digit);
      const was = old[index] ?? ' ';
      if (was !== digit) {
        const falling = el('span', 'cdt-flap-old', was.trim() === '' ? '' : was);
        falling.setAttribute('aria-hidden', 'true');
        if (lockOnce(falling, FLAP_FALL_MS, oneShotPhase(turned, FLAP_FALL_MS, facts.now))) flap.appendChild(falling);
      }
      board.appendChild(flap);
    });
    pass.appendChild(board);
  }
  box.appendChild(pass);
}

/**
 * The count as a look's own part: the digits, or "Today!" and its popper on
 * the day, with `--cd-chars` saying how many characters the box's width term
 * shares itself across — the clock's `--clock-chars`, one widget along.
 */
function countNode(className: string, partName: string | undefined, days: number, extraChars = 0): HTMLElement {
  const node = partName === undefined ? el('div', className) : part('div', className, partName);
  if (days === 0) {
    todayWords(node);
    node.style.setProperty('--cd-chars', String(TODAY_WORDS.length + 1 + extraChars));
  } else {
    node.textContent = countDigits(days);
    node.style.setProperty('--cd-chars', String(countDigits(days).length + extraChars));
  }
  return node;
}

/**
 * The occasion: the number dressed for Christmas, a birthday, Halloween, a
 * holiday, the end of term or New Year — an accent pair from the theme's own
 * tokens, the occasion's motif, and a scene behind it that moves.
 *
 * The count wears the pair's first token and its unit the second
 * (`OCCASION_LOOKS` says why both are legible on every theme). The motif —
 * beside the count, as tall as the count and its unit together — is the
 * occasion's picture, or the household's own on `custom`; a picture they
 * chose beside a named occasion rides with the label as it does on the number,
 * unless it is the motif already — a tree over "Christmas" with a tree in
 * front of it says the same thing twice.
 *
 * **The scene is behind the words and says nothing.** It is hidden from a
 * screen reader, sits in its own clipped layer, and is drawn from a fixed
 * table (`SCENE_SPOTS`) so its still frame — which is what a wall asking for
 * less motion, or with its Motion switch off, draws — is a picture of the same
 * snow rather than nothing.
 */
function drawOccasion(box: HTMLElement, facts: Countdown, config: unknown): void {
  const occasion = countdownOccasion(config);
  const look = OCCASION_LOOKS[occasion];
  box.dataset['occasion'] = occasion;
  box.style.setProperty('--oc-a', `var(${look.a})`);
  box.style.setProperty('--oc-b', `var(${look.b})`);

  box.appendChild(sceneLayer(look.scene, facts.now));

  // The motif beside the count rather than over it, so a wide, short box —
  // the one a forecast leaves, which is where a countdown most often goes —
  // keeps its tree: over the count it needs two more ledes of height, beside
  // it only the width a wide box already has.
  const head = el('div', 'cdo-head');
  const motif: EmojiKey | undefined = look.motif ?? facts.emoji;
  const picture = motif === undefined ? null : emojiNode(motif, 'cdo-motif-img');
  if (picture !== null) {
    const holder = part('div', 'cdo-motif', 'motif');
    holder.appendChild(picture);
    head.appendChild(holder);
  }
  const count = el('div', 'cdo-count');
  count.appendChild(countNode('cdo-num', 'num', facts.days));
  const unit = unitWords(facts.days, facts.words);
  if (unit !== '') count.appendChild(part('div', 'cdo-unit', 'unit', unit));
  head.appendChild(count);
  box.appendChild(head);
  const label = labelNode('cdo-label', { ...facts, emoji: facts.emoji === motif ? undefined : facts.emoji }, 'label');
  if (label !== undefined) box.appendChild(label);
}

/**
 * The layer an occasion's scene moves in: every piece placed from a fixed
 * table and locked to the wall clock through `lockLoop`, each a fixed share of
 * its cycle behind the one before, so a rebuilt scene puts every flake where
 * the old one had it and two walls in one house snow in step.
 *
 * `--x` and `--y` are where a piece rests, in percent of the box, so the
 * keyframes can carry it the whole way across the box from wherever it rests:
 * `--buw` and `--buh` are one percent of the box's width and height.
 */
function sceneLayer(scene: OccasionScene, now: number): HTMLElement {
  const layer = el('div', 'cdo-scene');
  layer.setAttribute('aria-hidden', 'true');
  layer.dataset['scene'] = scene;
  const place = (node: HTMLElement, left: number, top: number): void => {
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    node.style.setProperty('--x', String(left));
    node.style.setProperty('--y', String(top));
  };
  if (scene === 'waves') {
    const sun = emojiNode('sun', 'cdo-fx cdo-sun');
    if (sun !== null) {
      lockLoop(sun, OCCASION_SCENE_MS.waves, now);
      layer.appendChild(sun);
    }
    WAVE_BAND_MS.forEach((duration, index) => {
      const band = el('span', `cdo-fx cdo-wave cdo-wave-${index + 1}`);
      lockLoop(band, duration, now);
      layer.appendChild(band);
    });
    return layer;
  }
  if (scene === 'fireworks') {
    const duration = OCCASION_SCENE_MS.fireworks;
    FIREWORK_BURSTS.forEach((burst, index) => {
      const at = now + Math.round((index * duration) / FIREWORK_BURSTS.length);
      for (let spark = 0; spark < SPARKS; spark++) {
        const node = el('span', `cdo-fx cdo-spark${spark % 2 === 1 ? ' cdo-spark-b' : ''}`);
        place(node, burst.left, burst.top);
        const reach = sparkReach(spark);
        node.style.setProperty('--dx', String(reach.dx));
        node.style.setProperty('--dy', String(reach.dy));
        lockLoop(node, duration, at);
        layer.appendChild(node);
      }
    });
    return layer;
  }
  const duration = OCCASION_SCENE_MS[scene];
  const spots = SCENE_SPOTS[scene];
  spots.forEach((spot, index) => {
    const node =
      scene === 'balloons' ? emojiNode('balloon', 'cdo-fx cdo-balloon')
        : scene === 'leaves' ? emojiNode(index % 2 === 0 ? 'maple-leaf' : 'leaf-fallen', 'cdo-fx cdo-leaf')
          : scene === 'sparkles' ? emojiNode('sparkles', 'cdo-fx cdo-sparkle')
            : el('span', scene === 'snow' ? 'cdo-fx cdo-flake' : 'cdo-fx cdo-plane');
    if (node === null) return;
    place(node, spot.left, spot.top);
    lockLoop(node, duration, now + Math.round((index * duration) / spots.length));
    layer.appendChild(node);
  });
  return layer;
}

/**
 * The progress bar: the household's label, the count, a bar of the days gone
 * from the start date to the target, and the percentage under it.
 *
 * **It fills once, when the count changes** — at the first draw after
 * midnight, the bar grows from yesterday's length to today's (`changedAt`, the
 * tear-off page's rule), so a wall reloaded at noon draws the bar where it is
 * rather than growing it at nothing.
 *
 * With no start date, or one the stored config somehow holds on or after the
 * target, there is no honest length to draw, so the bar's place says what to
 * do about it rather than drawing one made up.
 */
function drawProgress(box: HTMLElement, facts: Countdown, config: unknown): void {
  const label = labelNode('cdg-label', facts, 'label');
  if (label !== undefined) box.appendChild(label);

  const unit = unitWords(facts.days, facts.words);
  const count = part('div', 'cdg-count', 'count');
  count.appendChild(countNode('cdg-num', undefined, facts.days, unit === '' ? 0 : 2.5));
  if (unit !== '') count.appendChild(el('span', 'cdg-unit', unit));
  box.appendChild(count);

  const from = countdownFrom(config);
  const progress = from === undefined ? undefined : countdownProgress(facts.today, from, facts.target);
  if (progress === undefined) {
    box.appendChild(part('div', 'cdg-empty', 'bar', 'Set a start date in this widget’s options.'));
    return;
  }
  const words = percentWords(progress);
  const bar = part('div', 'cdg-bar', 'bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', words);
  const fill = el('div', 'cdg-fill');
  fill.style.width = `${Math.round(progress.fraction * 10_000) / 100}%`;
  // Yesterday's length, as a share of today's: where a bar that grew at
  // midnight grows from.
  const was = Math.max(0, progress.gone - 1) / progress.total;
  if (progress.fraction > 0 && was < progress.fraction) {
    fill.style.setProperty('--cdg-was', String(Math.round((was / progress.fraction) * 1_000) / 1_000));
    const grew = changedAt(facts.memory, facts.widgetId, 'progress', facts.today, facts.now);
    lockOnce(fill, PROGRESS_FILL_MS, oneShotPhase(grew, PROGRESS_FILL_MS, facts.now));
  }
  bar.appendChild(fill);
  box.appendChild(bar);
  box.appendChild(part('div', 'cdg-pct', 'pct', words));
}

/**
 * A small month: the count, the target's month with the target circled and
 * today marked when today is in it, and the label.
 *
 * The squares are laid out from the household's own first day of the week,
 * so the mini month and the calendar beside it agree which column is Monday.
 * The ring and the mark are painted rather than bordered, so neither moves a
 * square: the grid's geometry is a function of the target's month and nothing
 * else (`reflow-stability`'s promise, kept by a widget that has no events).
 */
function drawMonth(box: HTMLElement, facts: Countdown, weekStart: 'sunday' | 'monday'): void {
  const unit = unitWords(facts.days, facts.words);
  const count = part('div', 'cdm-count', 'count');
  count.appendChild(countNode('cdm-num', undefined, facts.days, unit === '' ? 0 : 2.5));
  if (unit !== '') count.appendChild(el('span', 'cdm-unit', unit));
  box.appendChild(count);

  const month = miniMonth(facts.target, weekStart);
  const title = monthTitleWords(facts.target, DISPLAY_LOCALE);
  const targetDay = Number(facts.target.slice(8, 10));
  const todayDay = todayInMonth(facts.today, facts.target);
  const cal = part('div', 'cdm-cal', 'grid');
  cal.setAttribute('role', 'img');
  cal.setAttribute('aria-label', `${title}, with ${targetDateWords(facts.target, DISPLAY_LOCALE)} circled`);
  cal.appendChild(part('div', 'cdm-title', 'title', title));
  const grid = el('div', 'cdm-grid');
  for (const head of weekdayHeads(weekStart, DISPLAY_LOCALE)) grid.appendChild(part('span', 'cdm-head', 'heads', head));
  for (const week of month.weeks) {
    for (const day of week) {
      const square = el('span', 'cdm-day', day === null ? '' : String(day));
      if (day !== null && day === targetDay) square.classList.add('is-target');
      if (day !== null && day === todayDay) square.classList.add('is-today');
      grid.appendChild(square);
    }
  }
  cal.appendChild(grid);
  box.appendChild(cal);

  const label = labelNode('cdm-label', facts, 'label');
  if (label !== undefined) box.appendChild(label);
}

/**
 * The day's confetti: a burst the first time the day is drawn, and again no
 * sooner than an hour after the last (`repeatFiredAt`).
 *
 * Drawn only while it is playing. Its still frame is nothing — the pieces have
 * fallen out of the box — and every piece is transparent until its keyframes
 * move it, so a wall asking for reduced motion, or one whose Motion switch is
 * off, draws exactly what it would draw with no confetti at all.
 */
function drawConfetti(box: HTMLElement, facts: Countdown): void {
  const fired = repeatFiredAt(
    facts.memory,
    facts.widgetId,
    `celebrate:${facts.target}`,
    CELEBRATION_EVERY_MS,
    facts.now,
  );
  const phase = oneShotPhase(fired, CELEBRATION_MS, facts.now);
  if (!phase.playing) return;
  const burst = el('div', 'cd-confetti');
  burst.setAttribute('aria-hidden', 'true');
  for (const piece of confettiPieces()) {
    const bit = el('span', `cd-bit cd-bit-${piece.tone}`);
    bit.style.left = `${piece.left}%`;
    bit.style.setProperty('--cf-drift', String(piece.drift));
    bit.style.setProperty('--cf-turn', `${piece.turn}deg`);
    lockOnce(bit, CELEBRATION_MS, phase);
    burst.appendChild(bit);
  }
  box.appendChild(burst);
}
