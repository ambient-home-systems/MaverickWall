import { randomBytes } from 'node:crypto';

import { todoListHandle } from '../../api/manifest.js';
import type { SqliteDatabase } from '../../db/open.js';
import { parseJson, parseJsonOr, z } from '../../validation.js';
import { call, callService, HA_SERVICES, resolveConnection } from '../homeassistant/client.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Home Assistant to-do lists on the wall (RFC 012 phases 1 and 2).
 *
 * A module rather than a widening of the readings cache, because a list is not
 * a reading. `ha_entity_cache` is a snapshot of scalar states with a display
 * mode and a label, built for "Kitchen 19.4 °C"; a `todo.*` entity's *state* is
 * the number of incomplete items, so forcing one through that table would draw
 * "Shopping · 4" — which is not a shopping list, and is the same fault the
 * calendar entities shipped as "Bins · On". The items are not in the attributes
 * at all: they come back from a service call, and the service call is why rule
 * 12 had to change before any of this could be written.
 *
 * **With a job**, unlike chores: a list changes when somebody adds milk on
 * their phone, and nothing here can know that without asking. Sixty seconds,
 * matching the manifest poll — a shopping list is edited in bursts while
 * somebody is standing in a shop, which argues for faster, and an ESP32 panel
 * on a household with eight lists argues for slower. Sixty is the number both
 * sides can live with, and the cap on lists is what keeps "eight lists" from
 * becoming eighty.
 *
 * **Without `signals()`.** A shopping list that raises an interrupt is a wall
 * that nags, and the reasoning chores wrote down applies unchanged: easy to add
 * later, very hard to take back.
 *
 * **And one write, which is the only one this application makes.**
 * `tickTodoItem` sets an item's status through `callService`, and everything
 * that keeps it narrow is somewhere else: the allowlist is a frozen constant in
 * the Home Assistant client, the permission is `screens.allow_todo` on the wall
 * that asked, and the item is named by the `uid` the cache holds and never by
 * the summary a household typed. The endpoint is `POST /d/todo/tick`
 * (RFC 012 §7); this file owns the database either side of it.
 */

export const TODO_BLOCK = 'todo';

/** The poll, and the manifest poll it matches. */
export const TODO_POLL_MS = 60_000;

/**
 * How many lists a household may watch.
 *
 * Eight lists at sixty seconds is 11,520 requests a day against a Raspberry Pi
 * — two per poll per list, the state and the items — which is fine, and forty
 * lists would not be. A household with more than eight to-do lists on a kitchen
 * wall has a different problem from the one this module solves. The admin
 * refuses a ninth with a sentence rather than accepting it and polling slower,
 * because a poll interval that varies with a count is a setting nobody can
 * explain at a fridge.
 */
export const MAX_WATCHED_LISTS = 8;

/**
 * How many items of each status a list carries onto the wall.
 *
 * The typed to-do widget's own cap is forty lines, so forty is the number a
 * wall could plausibly draw — and the renderer's tier decides how many of
 * those actually are, the way it decides for the typed list. The total open
 * count travels beside them, so a list longer than the cap is still counted
 * honestly. Completed items are capped at the same number and carried
 * separately, because `showDone` is a display decision and cutting them at the
 * service would make it a second service call.
 */
export const TODO_MANIFEST_ITEMS = 40;

/**
 * More items than this on one list is refused, list and all.
 *
 * A "someday" list can be hundreds of items long, and the cache is small on
 * purpose — a shopping list, not a house. A list past this stays on its last
 * good rows and says why on the Home Assistant page, which is the same
 * degradation a network failure gets (rule nine): the wall keeps what it had.
 */
export const TODO_CACHE_ITEMS = 500;

/**
 * `TodoListEntityFeature.UPDATE_TODO_ITEM`, read out of
 * `homeassistant/components/todo/const.py`. `todo.update_item` is registered
 * with it as a required feature, so core itself refuses the call on a list
 * without it; the widget will omit the box for the same reason in phase 2, and
 * this is where both sides learn the answer.
 */
export const UPDATE_TODO_ITEM = 4;

// ---------------------------------------------------------------------------
// The watched lists — this module's corner of the database
// ---------------------------------------------------------------------------

export interface TodoListRow {
  readonly entityId: string;
  readonly name: string;
  readonly label: string | null;
  readonly supportsUpdate: boolean;
  readonly sortOrder: number;
  readonly lastFetchedAt: number | null;
  readonly lastError: string | null;
}

const SELECT_LISTS = `SELECT entity_id AS entityId, name, label, supports_update AS supportsUpdate,
        sort_order AS sortOrder, last_fetched_at AS lastFetchedAt, last_error AS lastError
   FROM ha_todo_lists ORDER BY sort_order, entity_id`;

export function readTodoLists(db: SqliteDatabase): TodoListRow[] {
  const rows = db.prepare(SELECT_LISTS).all() as (Omit<TodoListRow, 'supportsUpdate'> & {
    supportsUpdate: number;
  })[];
  return rows.map((row) => ({ ...row, supportsUpdate: row.supportsUpdate === 1 }));
}

/** The entity ids of every watched list, in the household's order. */
export function watchedTodoListIds(db: SqliteDatabase): string[] {
  return (db.prepare('SELECT entity_id AS entityId FROM ha_todo_lists ORDER BY sort_order, entity_id').all() as {
    entityId: string;
  }[]).map((row) => row.entityId);
}

export interface WatchTodoListInput {
  readonly entityId: string;
  readonly name: string;
  readonly label: string | null;
  readonly supportsUpdate: boolean;
}

export type WatchTodoListResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Start showing a list.
 *
 * Refuses a ninth rather than storing it — the cap is a fact about the poll
 * and it is enforced where the row is written, so a hand-posted form cannot
 * walk past the sentence on the page. Re-adding a list that is already watched
 * only updates its label, because "add" pressed twice is not a request for two
 * of them.
 *
 * The poll is brought forward so the list fills in rather than sitting empty
 * for a minute while somebody watches it — the same idiom `watchEntity` uses.
 */
export function watchTodoList(db: SqliteDatabase, input: WatchTodoListInput, at: number): WatchTodoListResult {
  const known = db
    .prepare('SELECT count(*) AS n FROM ha_todo_lists WHERE entity_id = ?')
    .get(input.entityId) as { n: number };
  if (known.n === 0) {
    const total = (db.prepare('SELECT count(*) AS n FROM ha_todo_lists').get() as { n: number }).n;
    if (total >= MAX_WATCHED_LISTS) {
      return {
        ok: false,
        message:
          `That is ${MAX_WATCHED_LISTS + 1} lists, and a wall reads at most ${MAX_WATCHED_LISTS}. ` +
          'Remove one you no longer show and add this one in its place.',
      };
    }
  }
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ha_todo_lists), ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         label = excluded.label, name = excluded.name, supports_update = excluded.supports_update,
         updated_at = excluded.updated_at`,
    ).run(input.entityId, input.name, input.label, input.supportsUpdate ? 1 : 0, at, at);
    db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = ?`).run(TODO_JOB_KIND);
  });
  write();
  return { ok: true };
}

/** Stop showing a list. Its cached items go with it: they are somebody's shopping. */
export function unwatchTodoList(db: SqliteDatabase, entityId: string): void {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM ha_todo_items WHERE entity_id = ?').run(entityId);
    db.prepare('DELETE FROM ha_todo_lists WHERE entity_id = ?').run(entityId);
  });
  write();
}

/**
 * Move a list one place in the household's order.
 *
 * The neighbour swaps rather than every row being renumbered, which is what the
 * other ordered lists here do — and it is what keeps a household's order theirs
 * when two people are on the page at once.
 */
export function moveTodoList(db: SqliteDatabase, entityId: string, direction: 'up' | 'down', at: number): void {
  const rows = readTodoLists(db);
  const index = rows.findIndex((row) => row.entityId === entityId);
  if (index < 0) return;
  const other = direction === 'up' ? index - 1 : index + 1;
  const neighbour = rows[other];
  const moving = rows[index];
  if (neighbour === undefined || moving === undefined) return;
  const write = db.transaction(() => {
    const update = db.prepare('UPDATE ha_todo_lists SET sort_order = ?, updated_at = ? WHERE entity_id = ?');
    // Renumber the whole list on the way, so two rows that had come to share an
    // order (a deletion, a hand edit) cannot make the swap a no-op.
    rows.forEach((row, position) => update.run(position, at, row.entityId));
    update.run(other, at, moving.entityId);
    update.run(index, at, neighbour.entityId);
  });
  write();
}

// ---------------------------------------------------------------------------
// What Home Assistant hands us, parsed
// ---------------------------------------------------------------------------

/** A `todo.*` entity as the picker offers it: a name and whether it can be ticked. */
export interface TodoEntity {
  readonly entityId: string;
  readonly name: string;
  readonly supportsUpdate: boolean;
}

/**
 * One `todo.*` entity out of `/api/states`.
 *
 * Loose about everything but the two facts this module needs, because a house
 * has integrations nobody here has heard of. `supported_features` is a bitmask
 * and it is read as one here and nowhere else: the wall receives a boolean.
 */
const todoState = z.looseObject({
  entity_id: z.string().regex(/^todo\.[a-z0-9_]+$/),
  attributes: z
    .looseObject({
      friendly_name: z.union([z.string(), z.number().transform((n) => String(n))]).nullable().catch(null),
      supported_features: z.number().int().nonnegative().catch(0),
    })
    .catch({ friendly_name: null, supported_features: 0 }),
});

function todoEntityOf(entry: unknown): TodoEntity | undefined {
  const shaped = todoState.safeParse(entry);
  if (!shaped.success) return undefined;
  const record = shaped.data;
  return {
    entityId: record.entity_id,
    name: record.attributes.friendly_name ?? record.entity_id,
    supportsUpdate: (record.attributes.supported_features & UPDATE_TODO_ITEM) === UPDATE_TODO_ITEM,
  };
}

/**
 * Every to-do list in `/api/states`, for the picker.
 *
 * The readings picker filters the same document to `SUPPORTED_DOMAINS`, which
 * deliberately excludes `todo` — a list is not a reading — so this is the other
 * reading of the same body. Never throws: one entity of a surprising shape is
 * skipped and the rest come through.
 */
export function parseTodoEntities(statesBody: string): TodoEntity[] {
  const entries = parseJsonOr(z.array(z.unknown()).catch([]), statesBody, []);
  const lists: TodoEntity[] = [];
  for (const entry of entries) {
    const list = todoEntityOf(entry);
    if (list !== undefined) lists.push(list);
  }
  return lists.sort((a, b) => a.name.localeCompare(b.name));
}

/** One list's state document (`GET /api/states/<entity>`), or nothing. */
export function parseTodoState(body: string): TodoEntity | undefined {
  try {
    return todoEntityOf(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** Home Assistant's two words for an item. There is no third. */
export type TodoStatus = 'needs_action' | 'completed';

export interface TodoItem {
  readonly uid: string;
  readonly summary: string;
  readonly status: TodoStatus;
  readonly due: string | null;
}

/*
 * One item, as `_api_items_factory` serialises it.
 *
 * Every type is exact and nothing is coerced: a `uid` that is not a string is
 * an item this module cannot identify, and a status that is not one of the two
 * words is one it cannot draw — either is a refused list, said on the Home
 * Assistant page, never a guess drawn on a wall (rule five). The two fields
 * Home Assistant also sends (`description`, and whatever a future release adds)
 * are stripped rather than refused, because they are facts about their
 * schema rather than about this one, and a list must not go dark over a field
 * nobody here reads.
 */
const todoItem = z.object({
  uid: z.string().min(1).max(255),
  summary: z.string().max(2000),
  status: z.enum(['needs_action', 'completed']),
  due: z.string().max(64).nullable().optional(),
});

/**
 * The `?return_response` envelope: `{ changed_states, service_response }`, the
 * response keyed by entity id. Strict about the shape that matters — the entity
 * this was asked for has to be the key, and its value has to be a list of items
 * — and capped, because the cache is deliberately small.
 */
function itemsEnvelope(entityId: string) {
  return z.object({
    changed_states: z.array(z.unknown()).optional(),
    service_response: z.object({
      [entityId]: z.object({ items: z.array(todoItem).max(TODO_CACHE_ITEMS) }),
    }),
  });
}

export type ParsedItems =
  | { readonly ok: true; readonly items: readonly TodoItem[] }
  | { readonly ok: false; readonly message: string };

/**
 * The items out of a `todo.get_items` answer, or a sentence.
 *
 * The sentence names no item and no entity: it is stored on
 * `ha_todo_lists.last_error`, which the Home Assistant page shows, and an item
 * is household content of the same class as an event title.
 */
export function parseItemsResponse(body: string, entityId: string): ParsedItems {
  const shaped = parseJson(itemsEnvelope(entityId), body);
  if (!shaped.ok) {
    return {
      ok: false,
      message:
        'Home Assistant answered, but not with a to-do list this version can read. ' +
        `A list is refused past ${TODO_CACHE_ITEMS} items, or when an item has no id.`,
    };
  }
  const list = shaped.value.service_response[entityId];
  const items = (list?.items ?? []).map((item) => ({
    uid: item.uid,
    summary: item.summary,
    status: item.status,
    due: item.due ?? null,
  }));
  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface TodoPanelItem {
  /** The synthetic handle this server minted. Opaque; what phase 2 will post. */
  readonly id: string;
  readonly summary: string;
  readonly done: boolean;
  /** As Home Assistant sent it, or null. Drawn nowhere yet. */
  readonly due: string | null;
  readonly position: number;
}

export interface TodoPanelList {
  /** `todoListHandle(entityId)` — what a widget's `list` resolves to on the wall. */
  readonly key: string;
  /** The household's label, or Home Assistant's own name. */
  readonly name: string;
  /** Whether `todo.update_item` would be accepted — bit 4, resolved to a boolean. */
  readonly canTick: boolean;
  /** How many items need doing, however many of them travel. */
  readonly open: number;
  /** Open items first in the list's own order, then the completed ones. */
  readonly items: readonly TodoPanelItem[];
}

export interface TodoPanel {
  readonly lists: readonly TodoPanelList[];
}

interface ItemRow {
  readonly id: string;
  readonly entityId: string;
  readonly summary: string;
  readonly status: string;
  readonly due: string | null;
  readonly position: number;
}

/**
 * The lists as the wall receives them.
 *
 * Exported so a test can build exactly what the manifest carries. Note what is
 * *not* here: no entity id, no `uid`, no `supported_features`, and no
 * timestamp. `lastFetchedAt` in particular is left out on purpose — the panel
 * travels inside `panels`, which is in `manifestEtag`'s preimage, so a stamp
 * that moved every minute would move the ETag every minute with nothing on the
 * list changed, and a battery panel would download a full frame on every poll.
 */
export function buildTodoPanel(db: SqliteDatabase): TodoPanel | null {
  const lists = readTodoLists(db);
  if (lists.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT id, entity_id AS entityId, summary, status, due, position
         FROM ha_todo_items ORDER BY position, uid`,
    )
    .all() as ItemRow[];

  return {
    lists: lists.map((list) => {
      const mine = rows.filter((row) => row.entityId === list.entityId);
      const open = mine.filter((row) => row.status !== 'completed');
      const done = mine.filter((row) => row.status === 'completed');
      const item = (row: ItemRow): TodoPanelItem => ({
        id: row.id,
        summary: row.summary,
        done: row.status === 'completed',
        due: row.due,
        position: row.position,
      });
      return {
        key: todoListHandle(list.entityId),
        name: list.label ?? list.name,
        canTick: list.supportsUpdate,
        open: open.length,
        items: [
          ...open.slice(0, TODO_MANIFEST_ITEMS).map(item),
          ...done.slice(0, TODO_MANIFEST_ITEMS).map(item),
        ],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The tick (RFC 012 phase 2)
// ---------------------------------------------------------------------------

/**
 * One cached item, resolved from the handle a wall posted.
 *
 * The entity id and the uid are in here and nowhere near a manifest: this is
 * the resolution rule 12's surviving clause (3) is built on. The wall holds an
 * opaque id this server minted and the server turns it back into the two facts
 * Home Assistant needs, so a compromised wall tablet can tick **only items it
 * has been shown** — it cannot enumerate lists, cannot reach a list the
 * household did not add, and cannot construct a handle for one.
 */
export interface TodoItemHandle {
  readonly id: string;
  readonly entityId: string;
  /** The identity Home Assistant matches on. Never the summary — see below. */
  readonly uid: string;
  readonly status: TodoStatus;
  /** Whether `todo.update_item` would be accepted on this item's list. */
  readonly canTick: boolean;
}

/**
 * The item a handle names, or nothing.
 *
 * Joined to the list rather than read in two queries, because the answer the
 * caller needs is one row: which item, and may it be ticked. A handle whose
 * item has left the list is simply absent — the row is deleted by the poll that
 * did not see it — and that is the 404 §7.4 calls the common case.
 */
export function readTodoItemHandle(db: SqliteDatabase, id: string): TodoItemHandle | undefined {
  const row = db
    .prepare(
      `SELECT i.id AS id, i.entity_id AS entityId, i.uid AS uid, i.status AS status,
              l.supports_update AS supportsUpdate
         FROM ha_todo_items i
         JOIN ha_todo_lists l ON l.entity_id = i.entity_id
        WHERE i.id = ?`,
    )
    .get(id) as
    | { id: string; entityId: string; uid: string; status: string; supportsUpdate: number }
    | undefined;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    entityId: row.entityId,
    uid: row.uid,
    status: row.status === 'completed' ? 'completed' : 'needs_action',
    canTick: row.supportsUpdate === 1,
  };
}

/**
 * Write the status this server has just watched Home Assistant accept.
 *
 * **Not an optimistic tick.** The endpoint has the upstream 200 in its hand
 * before this is called, so the cache is being brought level with a fact rather
 * than being guessed ahead of one. What it buys is the minute between now and
 * the next poll: without it a household presses a box and the wall carries on
 * saying the milk is outstanding until the job next runs, which is "pressing OK
 * on a wall and watching nothing happen" — a fault this project has shipped and
 * written up twice.
 *
 * `fetched_at` is deliberately left where it was. The poll's delete sweeps
 * every row it did not touch *by that stamp*, so moving it here would make an
 * item ticked between two polls survive a poll that no longer lists it.
 */
export function setTodoItemStatus(
  db: SqliteDatabase,
  id: string,
  status: TodoStatus,
): void {
  db.prepare('UPDATE ha_todo_items SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Set one item's status on one list, and the only write this application makes.
 *
 * `HA_SERVICES.write` is the whole of rule 12's permitted write and
 * `callService` is the one door it goes through — nothing here reaches the
 * network itself. What this function owns is the *body*, and one field of it is
 * the reason this phase exists at all:
 *
 * **`item` is always the uid.** Home Assistant's `_find_by_uid_or_summary`
 * matches `value in (item.uid, item.summary)` and returns the **first** hit, so
 * a household with "Milk" on the list twice, ticked by name, ticks whichever
 * one that integration happens to return first — a bug nobody can reproduce on
 * their own list. The uid is carried from the cache row the handle resolved to,
 * and the summary never leaves this server as an identity.
 */
export async function tickTodoItem(
  context: Pick<ModuleContext, 'db' | 'fetcher' | 'keyring'>,
  item: TodoItemHandle,
  done: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const resolved = resolveConnection(context.db, context.keyring);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const answer = await callService(context.fetcher, resolved.connection, HA_SERVICES.write, {
    entity_id: item.entityId,
    item: item.uid,
    status: done ? 'completed' : 'needs_action',
  });
  if (!answer.ok) return { ok: false, message: answer.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export const TODO_JOB_KIND = 'todo-sync';

/**
 * Read one list: its state, then its items, then the cache.
 *
 * Exported so the admin can run the first read inline when a list is added,
 * and say honestly whether it worked rather than "added and syncing" for a
 * list whose first poll failed. Never throws. Every failure is a sentence on
 * the row and the last good items kept.
 */
export async function pollTodoList(
  context: Pick<ModuleContext, 'db' | 'fetcher' | 'keyring' | 'now'>,
  entityId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const { db } = context;
  const resolved = resolveConnection(db, context.keyring);
  if (!resolved.ok) {
    const failure = { ok: false as const, message: resolved.message };
    recordListError(db, entityId, failure.message, context.now);
    return failure;
  }
  const connection = resolved.connection;

  /*
   * The state first, for `supported_features` — `get_items` does not return it,
   * and it is the one fact the phase-2 affordance rests on. Its friendly name
   * rides along, so a list renamed in Home Assistant is renamed here on the
   * next poll.
   */
  const state = await call(context.fetcher, connection, `/states/${encodeURIComponent(entityId)}`);
  const gone = 'That is not a to-do list Home Assistant knows about any more.';
  if (!state.ok) {
    /*
     * A 404 *here* is the entity, not the address — `/states/<entity>` answers
     * "Entity not found." for a list deleted on somebody's phone — and the
     * client's sentence for a 404 is written for the root. Said from the code
     * rather than the wording, which is the one thing `describe` cannot do for
     * a caller that asked about a single entity.
     */
    const message = state.httpStatus === 404 ? gone : state.message;
    recordListError(db, entityId, message, context.now);
    return { ok: false, message };
  }
  const entity = parseTodoState(state.body);
  if (entity === undefined) {
    recordListError(db, entityId, gone, context.now);
    return { ok: false, message: gone };
  }

  /*
   * Both statuses, named explicitly.
   *
   * Home Assistant's default for `status` is `needs_action` alone, and the
   * filter belongs to this code rather than to their default: "show the ticked
   * ones too" is a display decision, and it has to be answerable from the
   * cache without a second service call. `HA_SERVICES.read` is the one read the
   * allowlist permits; `callService` is the one door it goes through.
   */
  const answer = await callService(
    context.fetcher,
    connection,
    HA_SERVICES.read,
    { entity_id: entityId, status: ['needs_action', 'completed'] },
    { returnResponse: true },
  );
  if (!answer.ok) {
    recordListError(db, entityId, answer.message, context.now);
    return { ok: false, message: answer.message };
  }
  const parsed = parseItemsResponse(answer.body, entityId);
  if (!parsed.ok) {
    recordListError(db, entityId, parsed.message, context.now);
    return { ok: false, message: parsed.message };
  }

  storeItems(db, entityId, entity, parsed.items, context.now);
  return { ok: true };
}

/**
 * Replace a list's items without replacing their identities.
 *
 * The upsert is on `(entity_id, uid)` and the update leaves `id` alone, so an
 * item that is still on the list keeps the handle it had; anything the poll did
 * not touch is deleted afterwards, by its stamp. One transaction, so a reader
 * never sees half a list.
 */
function storeItems(
  db: SqliteDatabase,
  entityId: string,
  entity: TodoEntity,
  items: readonly TodoItem[],
  at: number,
): void {
  const upsert = db.prepare(
    `INSERT INTO ha_todo_items (id, entity_id, uid, summary, status, due, position, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, uid) DO UPDATE SET
       summary = excluded.summary, status = excluded.status, due = excluded.due,
       position = excluded.position, fetched_at = excluded.fetched_at`,
  );
  const write = db.transaction(() => {
    items.forEach((item, position) => {
      upsert.run(
        randomBytes(8).toString('hex'),
        entityId,
        item.uid,
        item.summary,
        item.status,
        item.due,
        position,
        at,
      );
    });
    // Whatever this poll did not touch has left the list.
    db.prepare('DELETE FROM ha_todo_items WHERE entity_id = ? AND fetched_at <> ?').run(entityId, at);
    db.prepare(
      `UPDATE ha_todo_lists
          SET name = ?, supports_update = ?, last_fetched_at = ?, last_error = NULL, updated_at = ?
        WHERE entity_id = ?`,
    ).run(entity.name, entity.supportsUpdate ? 1 : 0, at, at, entityId);
  });
  write();
}

/**
 * Record why a list did not read.
 *
 * The message is always the client's own wording or this module's, never a
 * response body and never an item: this column is shown on the Home Assistant
 * page and could otherwise carry something a household typed on their phone.
 * The cached items stay — a list from a minute ago is worth more than a hole.
 */
function recordListError(db: SqliteDatabase, entityId: string, message: string, at: number): void {
  db.prepare('UPDATE ha_todo_lists SET last_error = ?, updated_at = ? WHERE entity_id = ?').run(
    message,
    at,
    entityId,
  );
}

export const todoModule: PanelModule = {
  key: TODO_BLOCK,
  label: 'To-do lists',

  /**
   * Ready when the household has chosen a list.
   *
   * Not "is Home Assistant connected", for the reason the readings module gives:
   * a connection kept for calendars alone wants no list on the wall. Deciding on
   * the watched rows also means this touches no credential, which keeps the
   * manifest path free of the keyring. Disconnecting Home Assistant deletes the
   * rows (`disconnectHa`), so this cannot stay true over a connection that is
   * gone — a widget drawing a list that never refreshes is the fault that would
   * otherwise be.
   */
  ready(db: SqliteDatabase): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM ha_todo_lists').get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  contribute(context: ModuleContext): TodoPanel | null {
    return buildTodoPanel(context.db);
  },

  job: {
    kind: TODO_JOB_KIND,
    intervalMs: TODO_POLL_MS,

    async run(context: ModuleContext): Promise<void> {
      const lists = watchedTodoListIds(context.db);
      if (lists.length === 0) return;
      // One at a time, in order. A list that fails records its own sentence and
      // the next one is still read — a broken list costs itself, never the rest.
      for (const entityId of lists) {
        await pollTodoList(context, entityId);
      }
    },
  },
};
