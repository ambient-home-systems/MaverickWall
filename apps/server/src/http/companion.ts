import type { Context, Hono } from 'hono';
import type { Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { authenticateCompanion, presentedCompanionToken, touchCompanionToken } from '../api/companion.js';
import { addTodoItem, findTodoList, pollTodoList, todoListTitle } from '../modules/todo/index.js';
import { parse, z } from '../validation.js';

/**
 * The companion API (plan items M2.1 and M2.2): what a phone shortcut or a
 * Home Assistant automation calls, with a token instead of a session.
 *
 * One endpoint so far, `POST /companion/todo/add`, and it is the one write rule
 * 12 reserves for this API: `todo.add_item`, onto a list the household added,
 * never from a wall. It sits outside `/api/*` because that prefix is behind the
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

  app.post('/companion/todo/add', async (c: Context) => {
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

    let raw: unknown;
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    try {
      raw = type.startsWith('application/json') ? await c.req.json() : await c.req.parseBody();
    } catch {
      return answer(c, 400, { ok: false, error: 'bad-body', message: 'That body could not be read. Send JSON.' });
    }
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
}
