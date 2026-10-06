import type { Context, Hono } from 'hono';
import type { Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { authenticateCompanion, presentedCompanionToken, touchCompanionToken } from '../api/companion.js';
import { addTodoItem, findTodoList, pollTodoList, todoListTitle } from '../modules/todo/index.js';
import { parse, z } from '../validation.js';
import {
  DEFAULT_SHOW_MINUTES,
  MAX_SHOW_MINUTES,
  endLayoutOverride,
  findBrowserWall,
  requestRefresh,
  startLayoutOverride,
} from '../api/wall-commands.js';
import { MAX_LABEL, MAX_TIMER_MS, MIN_TIMER_MS, TIMER_ID, endTimers, startTimer } from '../modules/timers/index.js';
import {
  DEFAULT_MESSAGE_MINUTES,
  MAX_MESSAGE_MINUTES,
  MAX_MESSAGE_TEXT,
  MESSAGE_ID,
  clearMessages,
  postMessage,
} from '../modules/messages/index.js';

/**
 * The companion API (plan items M2.1 and M2.2): what a phone shortcut or a
 * Home Assistant automation calls, with a token instead of a session.
 *
 * `POST /companion/todo/add` is the one write rule 12 reserves for this API:
 * `todo.add_item`, onto a list the household added, never from a wall. The
 * rest — timers, messages, and telling walls to reload or to show one wall's
 * layout for a while — reach no house at all, only the walls of this one. It sits outside `/api/*` because that prefix is behind the
 * session gate, and a shortcut has no cookie; it is still behind the setup gate,
 * which answers it in JSON.
 *
 * **Nothing about a call is written down.** Not the token, not the item, not
 * the list — no log line at all on success, and none on a refusal either, since
 * a refused body is still somebody's shopping. What the household can see is
 * the token's "last used", on the admin page that shows it.
 */

/** Wrong tokens from one address before it is told to wait. Twenty in five minutes, `/pair`'s budget. */
const FAILED_WINDOW_MS = 5 * 60_000;
const FAILED_MAX = 20;
/**
 * Calls per account per minute. Thirty is far more than a person dictating a
 * shopping list and far fewer than an automation stuck in a loop would make —
 * which is the case this is for, since that automation's every call reaches the
 * household's Home Assistant.
 */
const USE_WINDOW_MS = 60_000;
const USE_MAX = 30;

/** Home Assistant's own limit on an item's text, and `buildCall`'s. */
const MAX_TEXT = 255;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The body, from JSON or a form — an iOS Shortcut sends either, and a Home
 * Assistant `rest_command` sends whichever its `content_type` says. Strict, so
 * a misspelt key is a sentence rather than an item silently added to the wrong
 * list; trimmed, because a dictated item arrives with a trailing space.
 */
export const companionAddBody = z
  .object({
    list: z
      .string()
      .trim()
      .min(1, 'Say which list, or leave it out when there is only one.')
      .max(MAX_TEXT, 'That list name is too long.')
      .optional(),
    item: z
      .string({ error: 'Say what to add, as “item”.' })
      .trim()
      .min(1, 'Say what to add, as “item”.')
      .max(MAX_TEXT, `An item can be at most ${MAX_TEXT} characters.`)
      .refine((text) => !CONTROL.test(text), 'An item cannot carry control characters.'),
  })
  .strict();

export interface CompanionDeps {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly now: () => number;
  readonly clientAddress: (c: Context) => string | undefined;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Count one more against a fixed window. True when the window is already spent. */
function over(buckets: Map<string, Bucket>, key: string, at: number, windowMs: number, max: number): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || at > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: at + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

function spent(buckets: Map<string, Bucket>, key: string, at: number, max: number): number | undefined {
  const bucket = buckets.get(key);
  if (bucket === undefined || at > bucket.resetAt || bucket.count < max) return undefined;
  return Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
}

/** A whole number, from JSON or from a form field, where it arrives as digits. Never anything else. */
const wholeNumber = z.union([z.number().int(), z.string().regex(/^\d{1,7}$/).transform(Number)]);
/** `all: true`, from JSON or a form. */
const allOf = z.union([z.literal(true), z.literal('true')]);

/** A short line of the household's own: trimmed, bounded, with no control characters. */
const ownText = (max: number, empty: string, long: string) =>
  z
    .string({ error: empty })
    .trim()
    .min(1, empty)
    .max(max, long)
    .refine((text) => !CONTROL.test(text), 'That cannot carry control characters.');

/**
 * Starting a timer: how long, in minutes or seconds — exactly one — and an
 * optional label. The bounds are `startTimer`'s and are checked there too.
 */
export const timerStartBody = z
  .object({
    minutes: wholeNumber
      .refine((n) => n >= 1 && n <= MAX_TIMER_MS / 60_000, 'A timer runs for between 1 and 1440 minutes.')
      .optional(),
    seconds: wholeNumber
      .refine(
        (n) => n >= MIN_TIMER_MS / 1000 && n <= MAX_TIMER_MS / 1000,
        'A timer runs for between 10 and 86400 seconds.',
      )
      .optional(),
    label: ownText(MAX_LABEL, 'A label cannot be empty — leave it out instead.', `A label can be at most ${MAX_LABEL} characters.`).optional(),
  })
  .strict()
  .refine((body) => (body.minutes === undefined) !== (body.seconds === undefined), {
    error: 'Say how long, as “minutes” or as “seconds” — one of them.',
  });

/** Ending timers: one by id, every one with a label, or all of them — exactly one. */
export const timerEndBody = z
  .object({
    id: z.string().regex(TIMER_ID, 'That is not a timer’s id.').optional(),
    label: ownText(MAX_LABEL, 'A label cannot be empty.', 'That label is too long.').optional(),
    all: allOf.optional(),
  })
  .strict()
  .refine((body) => [body.id, body.label, body.all].filter((one) => one !== undefined).length === 1, {
    error: 'Say which timer: its “id”, its “label”, or “all”: true.',
  });

/** Posting a message: the text, and for how many minutes (an hour when left out). */
export const messagePostBody = z
  .object({
    text: ownText(MAX_MESSAGE_TEXT, 'Say what the message is, as “text”.', `A message can be at most ${MAX_MESSAGE_TEXT} characters.`),
    minutes: wholeNumber
      .refine((n) => n >= 1 && n <= MAX_MESSAGE_MINUTES, `A message shows for between 1 and ${MAX_MESSAGE_MINUTES} minutes.`)
      .optional(),
  })
  .strict();

/** Clearing messages: one by id, or all of them — exactly one. */
export const messageClearBody = z
  .object({
    id: z.string().regex(MESSAGE_ID, 'That is not a message’s id.').optional(),
    all: allOf.optional(),
  })
  .strict()
  .refine((body) => (body.id === undefined) !== (body.all === undefined), {
    error: 'Say which message: its “id”, or “all”: true.',
  });

/** A wall, by its name or its id — trimmed, bounded, no control characters. */
const wallName = ownText(80, 'Say which wall, as “wall”.', 'That wall name is too long.');

/** Refreshing: one wall by name, or every browser wall when none is named. */
export const wallRefreshBody = z.object({ wall: wallName.optional() }).strict();

/** Showing one wall's layout on every wall: which, and for how many minutes (ten when left out). */
export const wallShowBody = z
  .object({
    wall: wallName,
    minutes: wholeNumber
      .refine((n) => n >= 1 && n <= MAX_SHOW_MINUTES, `A layout can be shown for between 1 and ${MAX_SHOW_MINUTES} minutes.`)
      .optional(),
  })
  .strict();

/** Stopping it: nothing to say. */
export const wallShowEndBody = z.object({}).strict();

/** "10 minutes", "90 seconds", "1 hour 30 minutes" — said back to whoever set it. */
export function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60 || seconds % 60 !== 0) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = seconds / 60;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 0 ? '' : `${hours} hour${hours === 1 ? '' : 's'}`;
  const m = rest === 0 ? '' : `${rest} minute${rest === 1 ? '' : 's'}`;
  return [h, m].filter((part) => part !== '').join(' ');
}

export function registerCompanionRoutes(app: Hono, deps: CompanionDeps): void {
  // Per app instance, not module-global, for the reason the pairing limit is:
  // tests keyed to one address stay independent.
  const failures = new Map<string, Bucket>();
  const uses = new Map<string, Bucket>();

  const answer = (c: Context, status: 200 | 400 | 401 | 404 | 409 | 429 | 502 | 503, body: object): Response => {
    // A response that says what was added must not sit in a cache between a
    // phone and this house.
    c.header('cache-control', 'no-store');
    return c.json(body, status);
  };

  /**
   * Everything every companion route asks first, in this order: is this
   * address spent on wrong tokens, is there a token, is it one, and is its
   * account spent on calls. Then the body, from JSON or a form. A route gets
   * the account and the body, or a response to send.
   */
  const admit = async (
    c: Context,
  ): Promise<{ readonly userId: string; readonly at: number; readonly raw: unknown } | Response> => {
    const at = deps.now();
    const address = deps.clientAddress(c) ?? 'shared';

    const wait = spent(failures, address, at, FAILED_MAX);
    if (wait !== undefined) {
      c.header('retry-after', String(wait));
      return answer(c, 429, { ok: false, error: 'rate-limited', message: 'Too many wrong tokens. Wait a few minutes.' });
    }

    const presented = presentedCompanionToken(c.req.header('authorization'), c.req.query('key'));
    if (presented === undefined) {
      return answer(c, 401, {
        ok: false,
        error: 'no-token',
        message: 'This needs your companion token, from System › Phone and automations, as “Authorization: Bearer …”.',
      });
    }
    const userId = authenticateCompanion(deps.db, presented.token);
    if (userId === undefined) {
      over(failures, address, at, FAILED_WINDOW_MS, FAILED_MAX);
      return answer(c, 401, {
        ok: false,
        error: 'bad-token',
        message: 'That token is not valid. It may have been replaced — copy it again from System › Phone and automations.',
      });
    }
    if (over(uses, userId, at, USE_WINDOW_MS, USE_MAX)) {
      c.header('retry-after', String(spent(uses, userId, at, USE_MAX) ?? 60));
      return answer(c, 429, { ok: false, error: 'rate-limited', message: 'Too many at once. Wait a minute.' });
    }

    const type = (c.req.header('content-type') ?? '').toLowerCase();
    try {
      // An empty JSON body is an empty object: "stop showing it" has nothing to say.
      if (type.startsWith('application/json')) {
        const text = await c.req.text();
        return { userId, at, raw: text.trim() === '' ? {} : (JSON.parse(text) as unknown) };
      }
      return { userId, at, raw: await c.req.parseBody() };
    } catch {
      return answer(c, 400, { ok: false, error: 'bad-body', message: 'That body could not be read. Send JSON.' });
    }
  };

  app.post('/companion/todo/add', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const { userId, at, raw } = admitted;
    const shaped = parse(companionAddBody, raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });

    const match = findTodoList(deps.db, shaped.value.list);
    if (!match.ok) {
      return answer(c, match.reason === 'not-found' || match.reason === 'none-watched' ? 404 : 409, {
        ok: false,
        error: match.reason,
        message: match.message,
      });
    }
    const title = todoListTitle(match.list);

    const added = await addTodoItem(
      { db: deps.db, fetcher: deps.fetcher, keyring: deps.keyring },
      match.list.entityId,
      shaped.value.item,
    );
    if (!added.ok) {
      const status = added.reason === 'connection' ? 503 : added.reason === 'refused' ? 409 : 502;
      return answer(c, status, { ok: false, error: added.reason, message: added.message });
    }
    touchCompanionToken(deps.db, userId, at);

    /*
     * Read the list back now rather than at the next minute's poll, so a wall
     * shows the item about as soon as the phone says it was added. Its failure
     * is the list's own sentence on the To-do lists screen and changes nothing
     * here: Home Assistant has already said yes.
     */
    await pollTodoList({ db: deps.db, fetcher: deps.fetcher, keyring: deps.keyring, now: deps.now() }, match.list.entityId);

    return answer(c, 200, { ok: true, list: title, message: `Added to ${title}.` });
  });

  /** Start a timer (plan item M2.2). Every wall with a Timers widget counts it down. */
  app.post('/companion/timers', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(timerStartBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    const durationMs =
      shaped.value.minutes !== undefined ? shaped.value.minutes * 60_000 : (shaped.value.seconds ?? 0) * 1000;
    const started = startTimer(deps.db, { durationMs, label: shaped.value.label ?? null }, admitted.at);
    if (!started.ok) return answer(c, 409, { ok: false, error: 'refused', message: started.message });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    const what = shaped.value.label === undefined ? 'Timer' : `${shaped.value.label} timer`;
    return answer(c, 200, {
      ok: true,
      id: started.timer.id,
      endsAt: started.timer.endsAt,
      message: `${what} set for ${durationWords(durationMs)}.`,
    });
  });

  /** End timers, running or done, by id, by label, or all (plan item M2.2). */
  app.post('/companion/timers/end', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(timerEndBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    const { id, label } = shaped.value;
    const ended = endTimers(
      deps.db,
      id !== undefined ? { id } : label !== undefined ? { label } : { all: true },
      admitted.at,
    );
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    if (ended === 0) return answer(c, 404, { ok: false, error: 'not-found', message: 'No timer matched, so nothing was ended.' });
    return answer(c, 200, { ok: true, ended, message: ended === 1 ? 'Timer ended.' : `${ended} timers ended.` });
  });

  /** Post a message (plan item M2.2). It goes on its own when it expires. */
  app.post('/companion/messages', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(messagePostBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    const minutes = shaped.value.minutes ?? DEFAULT_MESSAGE_MINUTES;
    const posted = postMessage(deps.db, { body: shaped.value.text, minutes }, admitted.at);
    if (!posted.ok) return answer(c, 409, { ok: false, error: 'refused', message: posted.reason });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    return answer(c, 200, {
      ok: true,
      id: posted.message.id,
      expiresAt: posted.message.expiresAt,
      message: `Posted for ${durationWords(minutes * 60_000)}.`,
    });
  });

  /** Reload one wall, or every browser wall (plan items M1.2, M2.3). */
  app.post('/companion/walls/refresh', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(wallRefreshBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    if (shaped.value.wall === undefined) {
      const refreshed = requestRefresh(deps.db, 'all', admitted.at);
      if (refreshed === 0) return answer(c, 404, { ok: false, error: 'not-found', message: 'There are no browser walls yet.' });
      return answer(c, 200, { ok: true, refreshed, message: 'Every browser wall reloads within a minute.' });
    }
    const match = findBrowserWall(deps.db, shaped.value.wall);
    if (!match.ok) return answer(c, match.reason === 'ambiguous' ? 409 : 404, { ok: false, error: match.reason, message: match.message });
    requestRefresh(deps.db, { id: match.wall.id }, admitted.at);
    return answer(c, 200, { ok: true, refreshed: 1, message: `${match.wall.name} reloads within a minute.` });
  });

  /** Show one wall's layout on every other browser wall for a while (plan items M1.3, M2.3). */
  app.post('/companion/walls/show', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(wallShowBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    const match = findBrowserWall(deps.db, shaped.value.wall);
    if (!match.ok) return answer(c, match.reason === 'ambiguous' ? 409 : 404, { ok: false, error: match.reason, message: match.message });
    const minutes = shaped.value.minutes ?? DEFAULT_SHOW_MINUTES;
    const started = startLayoutOverride(deps.db, match.wall.id, minutes, admitted.at);
    if (!started.ok) return answer(c, 409, { ok: false, error: 'refused', message: started.message });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    return answer(c, 200, {
      ok: true,
      until: started.until,
      message: `${match.wall.name}’s layout is on every other wall for ${durationWords(minutes * 60_000)}.`,
    });
  });

  /** Put every wall back on its own layout now (plan items M1.3, M2.3). */
  app.post('/companion/walls/show/end', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(wallShowEndBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    if (!endLayoutOverride(deps.db, admitted.at)) {
      return answer(c, 404, { ok: false, error: 'not-found', message: 'No wall’s layout was being shown.' });
    }
    return answer(c, 200, { ok: true, message: 'Every wall goes back to its own layout within a minute.' });
  });

  /** Clear messages, one by id or all (plan item M2.2). */
  app.post('/companion/messages/clear', async (c: Context) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const shaped = parse(messageClearBody, admitted.raw);
    if (!shaped.ok) return answer(c, 400, { ok: false, error: 'bad-body', message: shaped.message });
    const cleared = clearMessages(deps.db, shaped.value.id !== undefined ? { id: shaped.value.id } : { all: true });
    touchCompanionToken(deps.db, admitted.userId, admitted.at);
    if (cleared === 0) return answer(c, 404, { ok: false, error: 'not-found', message: 'No message matched, so nothing was cleared.' });
    return answer(c, 200, { ok: true, cleared, message: cleared === 1 ? 'Message cleared.' : `${cleared} messages cleared.` });
  });
}
