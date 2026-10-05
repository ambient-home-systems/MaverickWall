import { randomBytes } from 'node:crypto';

import type { Fetcher, UrlPolicy } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { z } from '../../validation.js';
import { recordWallAction, releasePress, takePress } from '../homeassistant/control.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Webhook buttons (RFC 018 §9, phase 5).
 *
 * A button on a wall that POSTs to an address the household set up in the
 * admin. **Not a Home Assistant service call**, so it does not go through
 * `HA_SERVICES` — but it is the same kind of act, so it sits behind the same
 * three switches: the wall's "Allow operating things in the house", this
 * target's "Can be pressed from walls", and a Buttons widget set to Tap to
 * operate. And like a scene or a script it cannot be undone by pressing again,
 * so the wall asks for a press-and-hold before it sends the press (OQ6).
 *
 * **What leaves is fixed here, not by anybody's form.** A POST with an empty
 * body, through the SSRF-guarded fetcher with the target's own network
 * opt-ins, never following a redirect (`REDIRECT_POLICY.POST`), and with no
 * header but the one optional secret header the household set. The response
 * body is read only as far as the fetcher must and then discarded: success or
 * failure comes back, as a sentence. "No household-authored body reaches the
 * network" stays true — there is no body.
 *
 * **The wall never sees an address.** The manifest carries each button's id
 * and name; the address is sealed (`webhook-url`) and opened only inside
 * `pressWebhook`, for the length of one request.
 */

export const BUTTONS_BLOCK = 'buttons';

/**
 * How many buttons a household may set up. Twelve is more than one wall shows
 * and few enough that the admin list stays a list; a thirteenth is refused
 * with a sentence rather than accepted.
 */
export const MAX_WEBHOOK_TARGETS = 12;

/** Small, because nothing is done with the answer but read its status. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** A header name the household may set: a token, and none of the ones the fetcher owns. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = ['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie'];

/** The add form, refused rather than coerced (rule five). */
export const webhookTargetBody = z
  .object({
    name: z.string().trim().min(1, 'Give the button a name.').max(40, 'Keep the name under 40 characters.'),
    url: z.string().trim().min(1, 'Paste the address the button should call.').max(2000),
    header_name: z.string().trim().max(64).optional(),
    header_value: z.string().max(512).optional(),
    allow_lan: z.preprocess((value) => typeof value === 'string' && value !== '', z.boolean()).optional(),
    allow_http: z.preprocess((value) => typeof value === 'string' && value !== '', z.boolean()).optional(),
  })
  .superRefine((value, context) => {
    const name = value.header_name ?? '';
    const secret = value.header_value ?? '';
    if ((name === '') !== (secret === '')) {
      context.addIssue({ code: 'custom', message: 'A header needs both a name and a value, or neither.' });
    } else if (name !== '' && (!HEADER_NAME.test(name) || RESERVED_HEADERS.includes(name.toLowerCase()))) {
      context.addIssue({ code: 'custom', message: 'That header name cannot be used.' });
    }
  });

export interface WebhookTargetRow {
  readonly id: string;
  readonly name: string;
  readonly headerName: string | null;
  readonly allowLan: boolean;
  readonly allowHttp: boolean;
  readonly pressable: boolean;
  readonly createdAt: number;
}

/** Every target, without its secrets, in the order the household made them. */
export function readWebhookTargets(db: SqliteDatabase): WebhookTargetRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, header_name AS headerName, allow_lan AS allowLan, allow_http AS allowHttp,
              pressable, created_at AS createdAt
         FROM webhook_targets ORDER BY sort_order, created_at, id`,
    )
    .all() as (Omit<WebhookTargetRow, 'allowLan' | 'allowHttp' | 'pressable'> & {
    allowLan: number;
    allowHttp: number;
    pressable: number;
  })[];
  return rows.map((row) => ({
    ...row,
    allowLan: row.allowLan === 1,
    allowHttp: row.allowHttp === 1,
    pressable: row.pressable === 1,
  }));
}

/** Seal and store a new target. The caller has validated it and checked the cap. */
export function createWebhookTarget(
  db: SqliteDatabase,
  keyring: Keyring,
  target: {
    readonly name: string;
    readonly url: string;
    readonly headerName: string | null;
    readonly headerValue: string | null;
    readonly allowLan: boolean;
    readonly allowHttp: boolean;
  },
  now: number,
): string {
  const id = `wh-${randomBytes(6).toString('hex')}`;
  const order = db.prepare('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM webhook_targets').get() as {
    n: number;
  };
  db.prepare(
    `INSERT INTO webhook_targets
       (id, name, url_encrypted, header_name, header_value_encrypted, allow_lan, allow_http,
        pressable, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    target.name,
    keyring.encrypt(target.url, 'webhook-url'),
    target.headerName,
    target.headerValue === null ? null : keyring.encrypt(target.headerValue, 'webhook-secret'),
    target.allowLan ? 1 : 0,
    target.allowHttp ? 1 : 0,
    order.n,
    now,
    now,
  );
  return id;
}

export function setWebhookPressable(db: SqliteDatabase, id: string, on: boolean, now: number): boolean {
  return (
    db.prepare('UPDATE webhook_targets SET pressable = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now, id)
      .changes > 0
  );
}

export function deleteWebhookTarget(db: SqliteDatabase, id: string): boolean {
  return db.prepare('DELETE FROM webhook_targets WHERE id = ?').run(id).changes > 0;
}

/**
 * The host of a target's address, for the admin to show — never the path,
 * which is where a webhook's secret lives. `undefined` when it cannot be read.
 */
export function webhookHost(db: SqliteDatabase, keyring: Keyring, id: string): string | undefined {
  const row = db.prepare('SELECT url_encrypted AS url FROM webhook_targets WHERE id = ?').get(id) as
    | { url: string }
    | undefined;
  if (row === undefined) return undefined;
  const opened = keyring.decrypt(row.url, 'webhook-url');
  if (!opened.ok) return undefined;
  try {
    return new URL(opened.value).host;
  } catch {
    return undefined;
  }
}

/**
 * Whether an address is a Home Assistant webhook — "a script by another name"
 * (RFC 018 §9), which carries the script warning. Judged by the path alone
 * rather than by the connected instance's host: a warning on a webhook into
 * somebody's *second* Home Assistant is a warning that is still true.
 */
export function isHomeAssistantWebhook(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/api/webhook/');
  } catch {
    return false;
  }
}

/** Whether a stored target calls a Home Assistant webhook, read from its sealed address. */
export function webhookCallsHomeAssistant(db: SqliteDatabase, keyring: Keyring, id: string): boolean {
  const row = db.prepare('SELECT url_encrypted AS url FROM webhook_targets WHERE id = ?').get(id) as
    | { url: string }
    | undefined;
  if (row === undefined) return false;
  const opened = keyring.decrypt(row.url, 'webhook-url');
  return opened.ok && isHomeAssistantWebhook(opened.value);
}

/** One button as the manifest carries it: an id and a name, and `press` only when it may be. */
export interface ButtonReading {
  readonly key: string;
  readonly label: string;
  readonly actions?: readonly string[];
}

export interface ButtonsPanel {
  readonly buttons: readonly ButtonReading[];
}

export const buttonsModule: PanelModule = {
  key: BUTTONS_BLOCK,
  label: 'Buttons',

  ready(db: SqliteDatabase): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM webhook_targets').get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  /**
   * Every button, by id and name. `actions` is spread only on a button the
   * household marked pressable, so a household with none marked sends a panel
   * that offers nothing to press — and none of this is in the manifest at all
   * until a first button exists, so nobody else's ETag moves.
   */
  contribute(context: ModuleContext): ButtonsPanel {
    // Only asked once `ready` says there is a button, so never with none.
    return {
      buttons: readWebhookTargets(context.db).map((target) => ({
        key: target.id,
        label: target.name,
        ...(target.pressable ? { actions: ['press'] } : {}),
      })),
    };
  },
};

export interface PressInput {
  /** A screen whose `allow_control` the route has already checked, before the body. */
  readonly screenId: string;
  readonly button: string;
  readonly widget: string;
}

export type PressResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 429 | 502;
      readonly error: string;
      readonly message: string;
    };

const NOT_HERE = 'That is not on this wall any more.';
const NOT_PRESSABLE = "That can't be pressed from a wall.";
const TOO_MANY = 'Too many presses. Try again in a moment.';

/** Whether the widget the press came from is a Buttons widget on this wall, set to act, showing this button. */
function widgetPresses(db: SqliteDatabase, screenId: string, widgetId: string, button: string): boolean {
  const row = db
    .prepare(`SELECT type, config FROM layout_widgets WHERE id = ? AND screen_id = ?`)
    .get(widgetId, screenId) as { type: string; config: string | null } | undefined;
  if (row === undefined || row.type !== 'buttons' || row.config === null) return false;
  let config: unknown;
  try {
    config = JSON.parse(row.config);
  } catch {
    return false;
  }
  if (typeof config !== 'object' || config === null) return false;
  const c = config as Record<string, unknown>;
  if (c['tapAction'] !== 'act') return false;
  const shown = c['buttons'];
  // No list, or an empty one, is every button — the widget's own reading of it.
  return !Array.isArray(shown) || shown.length === 0 || shown.includes(button);
}

/** What the household reads when the address answered, or did not. */
function sentenceFor(outcome: Awaited<ReturnType<Fetcher['fetch']>>): string {
  if (outcome.status === 'rejected') {
    return outcome.code === 'redirect-rejected'
      ? 'That address answered with a redirect, and a button never follows one. Use the address it moved to.'
      : 'That address is not one a wall button may call. Check it on the Buttons screen.';
  }
  if (outcome.status === 'failed') {
    if (outcome.code === 'timeout') return 'That address did not answer in time.';
    if (outcome.code === 'http-error' && outcome.httpStatus !== undefined) {
      return `That address refused the press (${outcome.httpStatus}).`;
    }
    return 'That address could not be reached.';
  }
  return 'That did not go through. Try again in a moment.';
}

/**
 * Press one webhook button from one wall, or say why not — RFC 018 §8.2's
 * order, with the target's switch in place of the entity's. Never throws.
 */
export async function pressWebhook(
  context: { readonly db: SqliteDatabase; readonly fetcher: Fetcher; readonly keyring: Keyring; readonly now: number },
  input: PressInput,
): Promise<PressResult> {
  const { db } = context;

  const row = db
    .prepare(
      `SELECT id, url_encrypted AS url, header_name AS headerName, header_value_encrypted AS headerValue,
              allow_lan AS allowLan, allow_http AS allowHttp, pressable
         FROM webhook_targets WHERE id = ?`,
    )
    .get(input.button) as
    | {
        id: string;
        url: string;
        headerName: string | null;
        headerValue: string | null;
        allowLan: number;
        allowHttp: number;
        pressable: number;
      }
    | undefined;
  if (row === undefined) return { ok: false, status: 404, error: 'no-such-button', message: NOT_HERE };
  if (row.pressable !== 1) return { ok: false, status: 403, error: 'not-pressable', message: NOT_PRESSABLE };
  if (!widgetPresses(db, input.screenId, input.widget, row.id)) {
    return { ok: false, status: 403, error: 'widget-does-not-act', message: NOT_PRESSABLE };
  }

  const key = `webhook:${row.id}`;
  if (!takePress(input.screenId, key, context.now)) {
    return { ok: false, status: 429, error: 'too-many', message: TOO_MANY };
  }
  try {
    const url = context.keyring.decrypt(row.url, 'webhook-url');
    if (!url.ok) {
      return {
        ok: false,
        status: 502,
        error: 'sealed',
        message: 'This button’s address could not be opened. Set it up again on the Buttons screen.',
      };
    }
    const headers: Record<string, string> = { 'content-length': '0' };
    if (row.headerName !== null && row.headerValue !== null) {
      const secret = context.keyring.decrypt(row.headerValue, 'webhook-secret');
      if (!secret.ok) {
        return {
          ok: false,
          status: 502,
          error: 'sealed',
          message: 'This button’s header could not be opened. Set it up again on the Buttons screen.',
        };
      }
      headers[row.headerName.toLowerCase()] = secret.value;
    }
    /*
     * The target's own opt-ins, as a calendar's are its own. "My own network"
     * includes this machine, as the Home Assistant connection's does: Node-RED
     * or Home Assistant running beside this container is the household's
     * network too, and a second switch for it would be a distinction nobody
     * standing at the form could make.
     */
    const policy: UrlPolicy = {
      allowHttp: row.allowHttp === 1,
      allowPrivateNetwork: row.allowLan === 1,
      allowLoopback: row.allowLan === 1,
    };
    const outcome = await context.fetcher.fetch({
      url: url.value,
      policy,
      method: 'POST',
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 10_000,
      headers,
    });
    const ok = outcome.status === 'ok';
    const message = ok ? null : sentenceFor(outcome);
    recordWallAction(db, { screenId: input.screenId, entityId: key, action: 'press', ok, message }, context.now);
    return ok ? { ok: true } : { ok: false, status: 502, error: 'upstream', message: message ?? '' };
  } finally {
    releasePress(key);
  }
}
