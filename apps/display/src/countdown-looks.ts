import {
  CELEBRATION_EMOJI,
  CELEBRATION_EVERY_MS,
  CELEBRATION_MS,
  FLAP_FALL_MS,
  PAGE_TEAR_MS,
  TODAY_WORDS,
  celebrates,
  confettiPieces,
  countDigits,
  countdownEmoji,
  countdownLabel,
  countdownTarget,
  countdownWords,
  daysUntil,
  previousDigits,
  targetDateWords,
  ticketLine,
  unitWords,
} from './countdown.js';
import { emojiNode } from './emoji.js';
import { changedAt, lockOnce, oneShotPhase, repeatFiredAt, type OneShotMemory } from './motion.js';
import { variantOf } from './variants.js';
import { DISPLAY_LOCALE, localDate } from './viewmodel.js';

/**
 * A countdown on the wall, in each of its designed looks (plan item P5.2).
 *
 * Three are drawn here: `number` (the countdown every wall has drawn, which
 * gains a picture and "sleeps"), `page` (a tear-off calendar page) and
 * `ticket` (a boarding pass). The other three — `occasion`, `progress` and
 * `month` — are the second half of the item and draw `number` until then,
 * which is `variants.ts`' rule that a look not designed yet draws its type's
 * default.
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
  readonly oneShots: OneShotMemory;
}

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
  const box = el('section', look === 'page' ? 'cd cd-page' : look === 'ticket' ? 'cd cd-ticket' : 'cd');
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
