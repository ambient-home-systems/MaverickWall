import type { Context, Hono } from 'hono';

import {
  describeSchedule,
  dueDatesBetween,
  addDays,
  type ChoreSchedule,
  type CivilDate,
} from '@maverick-wall/core';

import {
  createChore,
  deleteChore,
  localToday,
  moveChore,
  readChores,
  recentRecord,
  setChorePaused,
  updateChore,
  type ChoreRow,
} from '../api/chores.js';
import { readHousehold, readPeople } from '../api/queries.js';
import { checkbox, optionalText, parse, text, z } from '../validation.js';
import { escapeHtml, errorBlock, page, selectField, textField } from './html.js';
import { navModules, type AdminDeps } from './admin.js';

/**
 * The Chores screen — where a chore is *defined* (RFC 008 phase 1).
 *
 * Its own file rather than more of `admin.ts`, which is already past four
 * thousand lines and has needed one split (`admin-ha.ts`) for exactly this
 * reason. A feature that would push a file past what a person can read starts
 * in its own.
 *
 * **This screen is deliberately only half of chores.** Defining one — its name,
 * whose it is, when it falls due — is a rare, considered act, and the admin is
 * the right place for it. *Completing* one happens several times a day, by
 * whoever is standing in the kitchen, and putting that behind a household login
 * and a sidebar would be the wall's one recurring interaction made harder than
 * the wall it is printed on. That half is the wall's, and it is RFC 008 phases
 * 2 and 3.
 *
 * So there is no tick box here, and its absence is the design rather than an
 * omission. What this page owes the household instead is confidence that what
 * they typed means what they meant — hence the next-due readout on every card,
 * which is where a schedule anchored to next month shows itself.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How many upcoming dates a card shows. Enough to recognise a pattern. */
const PREVIEW_COUNT = 3;
/** How far ahead to look for them. A yearly-ish chore shows one, not none. */
const PREVIEW_DAYS = 400;

/**
 * The chore form, as a browser submits it.
 *
 * Every sub-field of every schedule kind is present on the page at once,
 * because these pages run no script and a select cannot reveal a fieldset
 * without one. Which of them *counts* is decided by `kind` — so the fields are
 * all optional here, and `superRefine` requires the ones the chosen kind needs.
 *
 * That is the cross-field pattern this codebase settled on: the rule lives
 * beside the fields it constrains rather than as three `if` statements down a
 * handler, and the message it produces is the one a person reads.
 *
 * The weekdays are seven separately-named checkboxes rather than one repeated
 * name, because `parseBody()` keeps the last value of a repeated field and
 * nothing else in this application depends on it doing otherwise. Six of seven
 * ticked days silently vanishing is not a bug worth inviting to save six lines.
 */
const choreBody = z
  .object({
    name: text('A name for the chore', 60),
    person_id: optionalText(64),
    due_time: optionalText(5),
    kind: z.enum(['daily', 'weekdays', 'everyNDays', 'monthlyDate', 'once'], {
      error: () => 'Choose how often it repeats.',
    }),
    day_0: checkbox(),
    day_1: checkbox(),
    day_2: checkbox(),
    day_3: checkbox(),
    day_4: checkbox(),
    day_5: checkbox(),
    day_6: checkbox(),
    every_n: optionalText(3),
    every_from: optionalText(10),
    month_day: optionalText(2),
    once_date: optionalText(10),
  })
  .superRefine((value, ctx) => {
    const problem = (message: string, path: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [path] });
    };
    const whole = (raw: string | undefined): number | undefined => {
      if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
      return Number(raw);
    };
    const isDate = (raw: string | undefined): boolean =>
      raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw);

    switch (value.kind) {
      case 'weekdays':
        if (!chosenDays(value).length) {
          problem('Tick at least one day of the week.', 'day_0');
        }
        break;
      case 'everyNDays': {
        const n = whole(value.every_n);
        if (n === undefined || n < 1 || n > 365) {
          problem('How often has to be a whole number of days, from 1 to 365.', 'every_n');
        }
        // The anchor is required rather than defaulted to today, because "every
        // 3 days" has no meaning without a day to count from and a silent
        // default would re-phase the chore whenever it was edited.
        if (!isDate(value.every_from)) problem('Choose the day it starts.', 'every_from');
        break;
      }
      case 'monthlyDate': {
        const day = whole(value.month_day);
        if (day === undefined || day < 1 || day > 28) {
          // 28 and no higher: see `ChoreSchedule` in core. A chore on the 31st
          // would behave differently in February with nothing on this form to
          // say which the household asked for.
          problem('Pick a day from 1 to 28.', 'month_day');
        }
        break;
      }
      case 'once':
        if (!isDate(value.once_date)) problem('Choose the day it happens.', 'once_date');
        break;
      default:
        break;
    }
  });

type ChoreBody = z.infer<typeof choreBody>;

/** The ticked weekdays, as the numbers `dayOfWeek` uses. */
function chosenDays(value: {
  day_0: boolean;
  day_1: boolean;
  day_2: boolean;
  day_3: boolean;
  day_4: boolean;
  day_5: boolean;
  day_6: boolean;
}): number[] {
  const flags = [
    value.day_0,
    value.day_1,
    value.day_2,
    value.day_3,
    value.day_4,
    value.day_5,
    value.day_6,
  ];
  return flags.map((on, day) => (on ? day : -1)).filter((day) => day >= 0);
}

/**
 * The schedule the form asked for.
 *
 * Only reached once `superRefine` has passed, so the fields each kind needs are
 * present — which is why this reads as a straight mapping rather than as a
 * second round of checks. The unreachable fallbacks are there because the
 * compiler cannot see that, not because a case is expected.
 */
function scheduleFrom(value: ChoreBody): ChoreSchedule {
  switch (value.kind) {
    case 'weekdays':
      return { kind: 'weekdays', days: chosenDays(value) };
    case 'everyNDays':
      return {
        kind: 'everyNDays',
        n: Number(value.every_n),
        from: value.every_from as CivilDate,
      };
    case 'monthlyDate':
      return { kind: 'monthlyDate', day: Number(value.month_day) };
    case 'once':
      return { kind: 'once', date: value.once_date as CivilDate };
    default:
      return { kind: 'daily' };
  }
}

export function registerChoreRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  /** Today in the household's own zone — the default anchor, and the preview's start. */
  const today = (): CivilDate => localToday(readHousehold(deps.db).timezone, now());

  app.get('/admin/chores', (c: Context) => c.html(choresPage()));

  app.post('/admin/chores', async (c: Context) => {
    const shaped = parse(choreBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(choresPage(shaped.message), 400);
    createChore(deps.db, {
      name: shaped.value.name,
      personId: personOrNull(shaped.value.person_id),
      schedule: scheduleFrom(shaped.value),
      dueTime: normaliseTime(shaped.value.due_time),
    });
    return c.redirect('/admin/chores', 302);
  });

  app.post('/admin/chores/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!readChores(deps.db).some((chore) => chore.id === id)) {
      return c.redirect('/admin/chores', 302);
    }
    const shaped = parse(choreBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(choresPage(shaped.message), 400);
    updateChore(deps.db, id, {
      name: shaped.value.name,
      personId: personOrNull(shaped.value.person_id),
      schedule: scheduleFrom(shaped.value),
      dueTime: normaliseTime(shaped.value.due_time),
    });
    return c.redirect('/admin/chores', 302);
  });

  /**
   * Pause or resume, as its own POST.
   *
   * Not a field on the edit form: pausing is a button on the card, and making
   * it part of a save would mean opening an editor and re-submitting every
   * other field to suspend the bins for a fortnight. It is also the control a
   * household reaches for *instead of* Remove, so it belongs beside it.
   */
  app.post('/admin/chores/:id/pause', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    setChorePaused(deps.db, c.req.param('id') ?? '', body['resume'] !== '1');
    return c.redirect('/admin/chores', 302);
  });

  /**
   * Removing a chore asks first, and names what goes with it.
   *
   * It did not, in the phases before this one, and it was defensible then:
   * nothing could record a completion, so there was no history to destroy. Now
   * there is — and there is a *Pause* beside the button that keeps it — so a
   * one-click Remove is the household silently choosing the destructive one of
   * two options they may not know are different. The same GET-then-POST shape
   * the People screen uses.
   */
  app.get('/admin/chores/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const chore = readChores(deps.db).find((candidate) => candidate.id === id);
    if (chore === undefined) return c.redirect('/admin/chores', 302);

    const record = recentRecord(deps.db, chore, today(), readHousehold(deps.db).timezone);
    return c.html(
      page({
        modules: navModules(deps.db),
        title: 'Remove chore',
        nav: 'chores',
        heading: `Remove “${chore.name}”?`,
        back: { label: 'Chores', href: 'admin/chores' },
        intro:
          'Every record of it having been done goes too, and that cannot be ' +
          'undone. To stop it appearing on the wall but keep its history, ' +
          'pause it instead.',
        body:
          (record === undefined || record.done === 0
            ? ''
            : `<p class="hint">It was done ${record.done} of the last ${record.of} ` +
              `${escapeHtml(record.weekday ?? (record.of === 1 ? 'time' : 'times'))}.</p>`) +
          `<form method="post" action="admin/chores/${encodeURIComponent(id)}/delete">` +
          `<button class="btn-danger" type="submit">Remove it and its history</button></form>` +
          `<form method="post" action="admin/chores/${encodeURIComponent(id)}/pause">` +
          `<button class="secondary" type="submit">Pause it instead</button></form>` +
          `<form method="get" action="admin/chores">` +
          `<button class="secondary" type="submit">Keep it</button></form>`,
      }),
    );
  });

  app.post('/admin/chores/:id/delete', (c: Context) => {
    deleteChore(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/chores', 302);
  });

  app.post('/admin/chores/:id/move', async (c: Context) => {
    const dir = String(((await c.req.parseBody()) as Record<string, unknown>)['dir'] ?? '');
    moveChore(deps.db, c.req.param('id') ?? '', dir === 'up' ? 'up' : 'down');
    return c.redirect('/admin/chores', 302);
  });

  /**
   * An unassigned chore is a real state, not a missing value.
   *
   * `person_id` of `""` is "the household's", which is what the empty option
   * means — plenty of chores belong to whoever gets there first.
   */
  function personOrNull(raw: string | undefined): string | null {
    if (raw === undefined || raw === '') return null;
    return readPeople(deps.db).some((person) => person.id === raw) ? raw : null;
  }

  /** `HH:MM` or null, the two things `<input type=time>` submits. */
  function normaliseTime(value: string | undefined): string | null {
    return value !== undefined && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? value : null;
  }

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  function personOptions(selected: string | null): string {
    return (
      `<option value=""${selected === null ? ' selected' : ''}>Anyone in the house</option>` +
      readPeople(deps.db)
        .map(
          (person) =>
            `<option value="${escapeHtml(person.id)}"` +
            `${person.id === selected ? ' selected' : ''}>${escapeHtml(person.name)}</option>`,
        )
        .join('')
    );
  }

  function kindOptions(selected: string): string {
    const kinds: readonly (readonly [string, string])[] = [
      ['daily', 'Every day'],
      ['weekdays', 'Certain days of the week'],
      ['everyNDays', 'Every so many days'],
      ['monthlyDate', 'A day of the month'],
      ['once', 'Just once'],
    ];
    return kinds
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`,
      )
      .join('');
  }

  function dayChecks(days: readonly number[], idPrefix: string): string {
    return (
      `<fieldset class="checks checks-inline"><legend class="kick">Days of the week</legend>` +
      DAY_NAMES.map(
        (label, day) =>
          `<label><input type="checkbox" id="${escapeHtml(idPrefix)}-day-${day}" ` +
          `name="day_${day}" value="1"${days.includes(day) ? ' checked' : ''}> ` +
          `${label}</label>`,
      ).join('') +
      `</fieldset>`
    );
  }

  /**
   * The next few days this chore falls due.
   *
   * The one readout on this page that is worth more than the sentence above it.
   * "Every 3 days" is easy to read and agree with; "every 3 days *starting the
   * 14th of next month*" reads exactly the same way and puts nothing on the
   * wall for a fortnight. Three real dates is where that shows.
   */
  function nextDue(chore: ChoreRow, from: CivilDate): string {
    // A paused chore has no next: it will not appear on a wall whatever its
    // schedule says, and listing dates it will be absent on is the "Not due
    // again" fault in the other direction — a true-sounding sentence about
    // something that is not going to happen.
    if (chore.paused) return 'Paused — not shown on any wall';
    const dates = dueDatesBetween(chore.schedule, from, addDays(from, PREVIEW_DAYS));
    if (dates.length === 0) {
      /*
       * An empty window is not the same as "never again", and saying so was a
       * live bug: a chore anchored years ahead read "Not due again" on a screen
       * whose whole job is to show the household what they just set up. Only a
       * one-off already past is genuinely over; everything else is a statement
       * about how far this readout looked, so it says that rather than claiming
       * more than it checked.
       */
      if (chore.schedule.kind === 'once' && chore.schedule.date < from) return 'Not due again';
      return `Nothing due in the next ${PREVIEW_DAYS} days`;
    }
    const shown = dates.slice(0, PREVIEW_COUNT);
    const label = (date: CivilDate): string =>
      date === from ? 'today' : `${DAY_NAMES[weekdayOf(date)]} ${date}`;
    return `Next: ${shown.map(label).join(' · ')}`;
  }

  /** The weekday of a civil date, without pulling the whole date machinery in. */
  function weekdayOf(date: CivilDate): number {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
  }

  function choreCard(chore: ChoreRow, from: CivilDate, first: boolean, last: boolean): string {
    const id = encodeURIComponent(chore.id);
    const swatch = chore.personColor ?? '#6B7684';
    const days = chore.schedule.kind === 'weekdays' ? chore.schedule.days : [];
    const everyN = chore.schedule.kind === 'everyNDays' ? String(chore.schedule.n) : '';
    const monthDay = chore.schedule.kind === 'monthlyDate' ? String(chore.schedule.day) : '';
    /*
     * A field belonging to a kind this chore is not gets *nothing*, never a
     * default.
     *
     * Seeding them with today read as fact: a monthly chore showed "Starting
     * 23/08/2026" and "On (just once) 23/08/2026", neither of which was true of
     * it, on a card whose job is to tell the household what they set up. Blank
     * is the honest answer, and switching a chore to that kind then asks for
     * the date rather than quietly adopting one nobody chose.
     */
    const everyFrom = chore.schedule.kind === 'everyNDays' ? chore.schedule.from : '';
    const onceDate = chore.schedule.kind === 'once' ? chore.schedule.date : '';

    /*
     * How it has been going, over the last few times it fell due.
     *
     * Occurrences rather than days, so a weekly chore's denominator is weeks —
     * and today is excluded because the day is not over, which is the
     * difference between a readout a household believes and one that tells them
     * they are behind at nine in the morning. Absent for a chore that has never
     * come round yet, where "0 of 0" says nothing.
     */
    /*
     * Not while it is paused.
     *
     * A paused chore's occurrences are days it was on no wall and nobody could
     * have done it, so "Done 0 of the last 7 times" is the new-chore fault
     * again: an accusation for something the household chose. The card already
     * says it is paused, which is the honest answer to "how is it going".
     *
     * Freezing the record at the moment of pausing would be better still and
     * needs a `paused_at` column to know when that was. Worth adding the day
     * somebody asks for it; not worth inventing a column for a sentence nobody
     * has missed yet.
     */
    const record = chore.paused
      ? undefined
      : recentRecord(deps.db, chore, from, readHousehold(deps.db).timezone);
    const recordLine =
      record === undefined
        ? ''
        : `<p class="hint">Done ${record.done} of the last ${record.of} ` +
          `${escapeHtml(record.weekday ?? (record.of === 1 ? 'time' : 'times'))}</p>`;

    return (
      `<article class="card${chore.paused ? ' is-paused' : ''}">` +
      `<h2><span class="swatch" style="--swatch:${escapeHtml(swatch)}"></span>` +
      `${escapeHtml(chore.name)}` +
      (chore.paused ? `<span class="tag">Paused</span>` : '') +
      `</h2>` +
      `<p class="host">${escapeHtml(describeSchedule(chore.schedule))}` +
      (chore.dueTime === null ? '' : ` · by ${escapeHtml(chore.dueTime)}`) +
      ` · ${escapeHtml(chore.personName ?? 'Anyone in the house')}</p>` +
      `<p class="hint">${escapeHtml(nextDue(chore, from))}</p>` +
      recordLine +

      /*
       * Folded away, because a list of chores has to read as a list.
       *
       * Expanded, one card is a name, a person, a repeat, a time, seven
       * weekday boxes and four date fields — around 400px on a desktop and
       * more than a whole viewport on a 390px phone. Four chores made a
       * five-thousand-pixel page whose actual content was three lines per
       * card, which is the same fault the wall editor had before it was split
       * into contexts. A `<details>` is the script-free version of that split:
       * the facts stay above it, the editor is one tap away, and the summary
       * says which chore it belongs to for anyone not looking at the screen.
       */
      `<details class="disclose"><summary>Edit ${escapeHtml(chore.name)}</summary>` +
      `<form method="post" action="admin/chores/${id}">` +
      `<div class="row-fields">` +
      textField({ label: 'Name', name: 'name', required: true, value: chore.name, attrs: 'maxlength="60"' }) +
      selectField({ label: 'Who does it', name: 'person_id', optionsHtml: personOptions(chore.personId) }) +
      `</div>` +
      `<div class="row-fields">` +
      selectField({ label: 'Repeats', name: 'kind', optionsHtml: kindOptions(chore.schedule.kind) }) +
      textField({ label: 'By (optional)', name: 'due_time', type: 'time', value: chore.dueTime ?? '' }) +
      `</div>` +
      dayChecks(days, chore.id) +
      `<div class="row-fields">` +
      textField({ label: 'Every N days', name: 'every_n', type: 'number', value: everyN, attrs: 'min="1" max="365"' }) +
      textField({ label: 'Starting', name: 'every_from', type: 'date', value: everyFrom }) +
      `</div>` +
      `<div class="row-fields">` +
      textField({ label: 'Day of the month', name: 'month_day', type: 'number', value: monthDay, attrs: 'min="1" max="28"' }) +
      textField({ label: 'On (just once)', name: 'once_date', type: 'date', value: onceDate }) +
      `</div>` +
      `<p class="hint">Only the boxes belonging to the “Repeats” choice above are used. ` +
      `A day of the month goes up to 28, so the chore lands in February the same ` +
      `way it lands in every other month.</p>` +
      `<button type="submit">Save</button></form></details>` +

      `<div class="row">` +
      (first
        ? ''
        : `<form method="post" action="admin/chores/${id}/move">` +
          `<input type="hidden" name="dir" value="up">` +
          `<button class="secondary" type="submit">↑ Up</button></form>`) +
      (last
        ? ''
        : `<form method="post" action="admin/chores/${id}/move">` +
          `<input type="hidden" name="dir" value="down">` +
          `<button class="secondary" type="submit">↓ Down</button></form>`) +
      `<form method="post" action="admin/chores/${id}/pause" style="margin-left:auto">` +
      (chore.paused ? `<input type="hidden" name="resume" value="1">` : '') +
      `<button class="secondary" type="submit">${chore.paused ? 'Resume' : 'Pause'}</button></form>` +
      `<form method="get" action="admin/chores/${id}/delete">` +
      `<button class="btn-danger" type="submit">Remove</button></form>` +
      `</div></article>`
    );
  }

  function choresPage(error?: string): string {
    const chores = readChores(deps.db);
    const from = today();
    const people = readPeople(deps.db);

    return page({
      modules: navModules(deps.db),
      title: 'Chores — Maverick Wall',
      nav: 'chores',
      heading: 'Chores',
      action: { label: 'Add a chore', href: 'admin/chores#add' },
      intro:
        'What gets done around the house, and when. Chores are set up here and ' +
        'shown on the wall — this is the screen you come back to twice a year, ' +
        'not the one anybody uses to say a chore is done.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (people.length === 0
          ? `<p class="hint">Chores can belong to a person or to the household. ` +
            `<a class="link" href="admin/people">Add people</a> first if you want ` +
            `them assigned — a chore inherits that person’s colour on the wall.</p>`
          : '') +
        (chores.length === 0
          ? `<p class="hint">No chores yet. Add one below and it will appear here ` +
            `with the next few days it falls due, so you can check it means what ` +
            `you meant.</p>`
          : chores
              .map((chore, index) =>
                choreCard(chore, from, index === 0, index === chores.length - 1),
              )
              .join('')) +

        `<h2 class="add" id="add">Add a chore</h2>` +
        `<form method="post" action="admin/chores">` +
        `<div class="row-fields">` +
        textField({ label: 'Name', name: 'name', required: true, placeholder: 'Put the bins out', attrs: 'maxlength="60"' }) +
        selectField({ label: 'Who does it', name: 'person_id', optionsHtml: personOptions(null) }) +
        `</div>` +
        `<div class="row-fields">` +
        selectField({ label: 'Repeats', name: 'kind', optionsHtml: kindOptions('weekdays') }) +
        textField({ label: 'By (optional)', name: 'due_time', type: 'time' }) +
        `</div>` +
        dayChecks([], 'new') +
        `<div class="row-fields">` +
        textField({ label: 'Every N days', name: 'every_n', type: 'number', attrs: 'min="1" max="365"' }) +
        // Today, on the *add* form only: a chore being created has no anchor yet,
        // so this is a suggestion rather than a claim about what was saved.
        textField({ label: 'Starting', name: 'every_from', type: 'date', value: from }) +
        `</div>` +
        `<div class="row-fields">` +
        textField({ label: 'Day of the month', name: 'month_day', type: 'number', attrs: 'min="1" max="28"' }) +
        textField({ label: 'On (just once)', name: 'once_date', type: 'date', value: from }) +
        `</div>` +
        `<p class="hint">Pick how it repeats, then fill in only the boxes that ` +
        `belong to it. “By” is a time of day the wall shows beside the chore; ` +
        `leave it blank for any time that day.</p>` +
        `<button type="submit">Add</button></form>`,
    });
  }
}
