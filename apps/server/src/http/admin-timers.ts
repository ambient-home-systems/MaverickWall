import type { Context, Hono } from 'hono';

import { readHousehold } from '../api/queries.js';
import {
  DONE_SHOWN_MS,
  MAX_LABEL,
  TIMER_ID,
  endTimers,
  readLiveTimers,
  startTimer,
  type TimerRow,
} from '../modules/timers/index.js';
import {
  DEFAULT_MESSAGE_MINUTES,
  MAX_MESSAGE_MINUTES,
  MAX_MESSAGE_TEXT,
  MESSAGE_ID,
  clearMessages,
  postMessage,
  readLiveMessages,
  type MessageRow,
} from '../modules/messages/index.js';
import { parse, z } from '../validation.js';
import { errorBlock, escapeHtml, page, textField } from './html.js';
import { emptyState, listRow, section, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * Timers and messages, in the admin (plan items M5.1–M5.2).
 *
 * The same timers and messages a phone sends through the companion API, which
 * is the commoner way in: this is where a household sees what is on the walls
 * and ends or clears it, and where somebody without the token set up can still
 * start one. Adding is a page of its own (P2.1); ending a timer and clearing a
 * message are buttons on their rows, since neither destroys anything a second
 * one would not put back.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ownText = (max: number, empty: string) =>
  z
    .string({ error: empty })
    .trim()
    .min(1, empty)
    .max(max, `That can be at most ${max} characters.`)
    .refine((text) => !CONTROL.test(text), 'That cannot carry control characters.');
const minutesField = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, 'Give a whole number of minutes.')
    .transform(Number)
    .refine((n) => n >= 1 && n <= max, `Between 1 and ${max} minutes.`);

const startBody = z.object({
  minutes: minutesField(24 * 60),
  label: z.union([z.literal(''), ownText(MAX_LABEL, 'A label cannot be blank.')]).optional(),
});

const postBody = z.object({
  text: ownText(MAX_MESSAGE_TEXT, 'Say what the message is.'),
  minutes: minutesField(MAX_MESSAGE_MINUTES),
});

export function registerTimerRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  /** "14:32", in the household's own zone. */
  const clock = (at: number): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: readHousehold(deps.db).timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));

  app.get('/admin/timers', (c: Context) => c.html(listPage(c)));
  app.get('/admin/timers/new', (c: Context) => c.html(newPage(c)));

  app.post('/admin/timers', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(startBody, body);
    if (!shaped.ok) return c.html(newPage(c, { timer: shaped.message }, body), 400);
    const label = shaped.value.label === undefined || shaped.value.label === '' ? null : shaped.value.label;
    const started = startTimer(deps.db, { durationMs: shaped.value.minutes * 60_000, label }, now());
    if (!started.ok) return c.html(newPage(c, { timer: started.message }, body), 409);
    return savedRedirect(c, '/admin/timers', 'timer-started');
  });

  app.post('/admin/timers/:id/end', (c: Context) => {
    const id = c.req.param('id') ?? '';
    // A token is a claim: a timer that had already gone ended nothing.
    if (!TIMER_ID.test(id) || endTimers(deps.db, { id }, now()) === 0) return c.redirect('/admin/timers', 302);
    return savedRedirect(c, '/admin/timers', 'timer-ended');
  });

  app.post('/admin/messages', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(postBody, body);
    if (!shaped.ok) return c.html(newPage(c, { message: shaped.message }, body), 400);
    const posted = postMessage(deps.db, { body: shaped.value.text, minutes: shaped.value.minutes }, now());
    if (!posted.ok) return c.html(newPage(c, { message: posted.reason }, body), 409);
    return savedRedirect(c, '/admin/timers', 'message-posted');
  });

  app.post('/admin/messages/:id/clear', (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!MESSAGE_ID.test(id) || clearMessages(deps.db, { id }) === 0) return c.redirect('/admin/timers', 302);
    return savedRedirect(c, '/admin/timers', 'message-cleared');
  });

  function timerRow(timer: TimerRow, at: number): string {
    const done = timer.endsAt <= at;
    const detail = done
      ? `Finished at ${clock(timer.endsAt)}. It leaves the walls at ${clock(timer.endsAt + DONE_SHOWN_MS)} unless it is cleared.`
      : `Ends at ${clock(timer.endsAt)}.`;
    return listRow(
      done ? tag('Done', 'accent') : tag('Running', 'ok'),
      { title: timer.label ?? 'Timer', detail },
      `<form method="post" action="admin/timers/${encodeURIComponent(timer.id)}/end">` +
        `<button class="secondary" type="submit" aria-label="${escapeHtml(`${done ? 'Clear' : 'End'} ${timer.label ?? 'the timer'}`)}">` +
        `${done ? 'Clear' : 'End'}</button></form>`,
    );
  }

  function messageRow(message: MessageRow): string {
    return listRow(
      '',
      { title: message.body, detail: `Sent at ${clock(message.postedAt)}; goes at ${clock(message.expiresAt)}.` },
      `<form method="post" action="admin/messages/${encodeURIComponent(message.id)}/clear">` +
        `<button class="secondary" type="submit" aria-label="Clear this message">Clear</button></form>`,
    );
  }

  function listPage(c: Context): string {
    const at = now();
    const timers = readLiveTimers(deps.db, at);
    const messages = readLiveMessages(deps.db, at);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Timers and messages — Maverick Wall',
      nav: 'timers',
      heading: 'Timers and messages',
      saved: readSaved(c),
      action: { label: 'Add a timer or message', href: 'admin/timers/new' },
      intro:
        'What every wall with a Timers or Messages widget is showing now. They are usually sent ' +
        'from a phone — see System › Phone and automations — and they go on their own: a timer ' +
        'half an hour after it finishes, a message when it expires.',
      body:
        section(
          'Timers',
          undefined,
          timers.length === 0
            ? emptyState('No timers running.')
            : timers.map((timer) => timerRow(timer, at)).join(''),
        ) +
        section(
          'Messages',
          undefined,
          messages.length === 0 ? emptyState('No messages showing.') : messages.map(messageRow).join(''),
        ),
    });
  }

  /**
   * Both forms on one page, because the app bar has one "Add" (P2.1) and the
   * two are the same act — putting something on the walls for a while. A
   * refused form comes back with what was typed, and its reason beside it.
   */
  function newPage(
    c: Context,
    error?: { readonly timer?: string; readonly message?: string },
    values?: Record<string, unknown>,
  ): string {
    const typed = (key: string, fallback = ''): string =>
      typeof values?.[key] === 'string' ? (values[key] as string) : fallback;
    const timerError = error?.timer;
    const messageError = error?.message;
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a timer or message — Maverick Wall',
      nav: 'timers',
      heading: 'Add a timer or message',
      back: { label: 'Timers and messages', href: 'admin/timers' },
      body:
        section(
          'Start a timer',
          'Every wall with a Timers widget counts it down, and says Done when it ends.',
          (timerError === undefined ? '' : errorBlock(timerError)) +
            `<form method="post" action="admin/timers">` +
            textField({
              label: 'Minutes',
              name: 'minutes',
              type: 'number',
              required: true,
              value: values === undefined || error?.timer === undefined ? '10' : typed('minutes'),
              attrs: 'min="1" max="1440" inputmode="numeric"',
            }) +
            textField({
              label: 'Label (optional)',
              name: 'label',
              placeholder: 'Pasta',
              value: error?.timer === undefined ? '' : typed('label'),
              attrs: `maxlength="${MAX_LABEL}"`,
            }) +
            `<button type="submit">Start timer</button></form>`,
        ) +
        section(
          'Send a message',
          'Every wall with a Messages widget shows it until it expires.',
          (messageError === undefined ? '' : errorBlock(messageError)) +
            `<form method="post" action="admin/messages">` +
            textField({
              label: 'Message',
              name: 'text',
              required: true,
              placeholder: 'Back at 6',
              value: error?.message === undefined ? '' : typed('text'),
              attrs: `maxlength="${MAX_MESSAGE_TEXT}"`,
            }) +
            textField({
              label: 'Show it for (minutes)',
              name: 'minutes',
              type: 'number',
              required: true,
              value: error?.message === undefined ? String(DEFAULT_MESSAGE_MINUTES) : typed('minutes'),
              attrs: `min="1" max="${MAX_MESSAGE_MINUTES}" inputmode="numeric"`,
            }) +
            `<button type="submit">Send message</button></form>`,
        ),
    });
  }
}
