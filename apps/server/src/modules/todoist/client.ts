import { FETCH_LIMITS, type Fetcher, type FetchOutcome, type UrlPolicy } from '@maverick-wall/core';

import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJson, z } from '../../validation.js';

/**
 * Todoist's API, the narrow part this application speaks (plan item M5.7).
 *
 * Todoist API v1 — `rest/v2` answers 410 and says so — read out of the
 * OpenAPI description its documentation embeds, then probed: `/projects` and
 * `/tasks` answer 401 without a token, and `/tasks/{id}/close` answers 405 to a
 * GET. Five calls and no others: list the projects (to offer them), list a
 * project's open tasks (to draw them), close and reopen a task (the wall's
 * tick) and create a task (the companion API's add). Nothing deletes, moves,
 * edits or reaches another project; the module decides which project, from
 * the household's own list, and never from what a wall or a phone sent.
 *
 * **One door, the fetcher, with a fixed address.** `https://api.todoist.com`
 * is a constant here and not anything a household typed, so the request goes
 * through the SSRF guard with the default policy — public https only. A test
 * points the same code at a loopback stand-in through `TodoistEndpoint`, which
 * nothing in the product sets.
 *
 * **Every answer is parsed, and nothing is coerced** (rule five): a task with
 * no id or no text is a list this version cannot read, said in a sentence; the
 * many fields Todoist sends that nothing here reads are stripped.
 */

export const TODOIST_API = 'https://api.todoist.com/api/v1';

/** Where Todoist is: the real one, or a test's stand-in. */
export interface TodoistEndpoint {
  readonly base: string;
  readonly policy: UrlPolicy;
}

export const TODOIST: TodoistEndpoint = { base: TODOIST_API, policy: {} };

/** The page size Todoist allows at most, and how many pages a list may take. */
const PAGE = 200;
/** A list past this is refused whole, as a Home Assistant list is (`TODO_CACHE_ITEMS`). */
export const TODOIST_MAX_ITEMS = 500;

export type TodoistResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Why a request did not go through, written for somebody standing in a kitchen. */
export function todoistFailure(outcome: FetchOutcome): string {
  if (outcome.status === 'failed' && outcome.code === 'http-error') {
    const status = outcome.httpStatus ?? 0;
    if (status === 401 || status === 403) {
      return 'Todoist did not accept the token. Paste a new one on the Todoist screen.';
    }
    if (status === 404) return 'That is not in Todoist any more.';
    if (status === 429) return 'Todoist asked for a pause. It will be tried again in a minute.';
    return `Todoist refused it (${status}). It will be tried again.`;
  }
  if (outcome.status === 'failed' && outcome.code === 'timeout') {
    return 'Todoist did not answer in time. It will be tried again.';
  }
  return 'Todoist could not be reached. It will be tried again.';
}

async function request(
  fetcher: Fetcher,
  endpoint: TodoistEndpoint,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Readonly<Record<string, string>>,
): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly message: string }> {
  const outcome = await fetcher.fetch({
    url: `${endpoint.base}${path}`,
    policy: endpoint.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 15_000,
    userAgent: DEFAULT_USER_AGENT,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { method: 'POST' as const, body: body === undefined ? '' : JSON.stringify(body) }),
  });
  if (outcome.status !== 'ok') return { ok: false, message: todoistFailure(outcome) };
  return { ok: true, body: outcome.body };
}

const id = z.string().min(1).max(64);
const project = z.object({ id, name: z.string().max(200), is_archived: z.boolean().optional(), is_deleted: z.boolean().optional() });
const projectsPage = z.object({ results: z.array(project), next_cursor: z.string().nullable() });

export interface TodoistProject {
  readonly id: string;
  readonly name: string;
}

/** Every open project, in Todoist's order, for the household to choose from. */
export async function listProjects(
  fetcher: Fetcher,
  endpoint: TodoistEndpoint,
  token: string,
): Promise<TodoistResult<readonly TodoistProject[]>> {
  const out: TodoistProject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const answer = await request(
      fetcher,
      endpoint,
      token,
      `/projects?limit=${PAGE}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    if (!answer.ok) return answer;
    const parsed = parseJson(projectsPage, answer.body);
    if (!parsed.ok) return { ok: false, message: 'Todoist answered, but not with projects this version can read.' };
    for (const one of parsed.value.results) {
      if (one.is_archived !== true && one.is_deleted !== true) out.push({ id: one.id, name: one.name });
    }
    cursor = parsed.value.next_cursor;
    if (cursor === null) break;
  }
  return { ok: true, value: out };
}

const task = z.object({
  id,
  content: z.string().max(2000),
  checked: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  parent_id: z.string().nullable().optional(),
  child_order: z.number().int().optional(),
  due: z.object({ date: z.string().max(64) }).nullable().optional(),
});
const tasksPage = z.object({ results: z.array(task), next_cursor: z.string().nullable() });

export interface TodoistTask {
  readonly id: string;
  readonly content: string;
  readonly due: string | null;
}

/**
 * A project's open tasks, top level only, in the project's own order.
 *
 * `GET /tasks` answers open tasks and nothing else, so a list from Todoist has
 * no completed items to show beyond one ticked on a wall moments ago. Subtasks
 * are left out: a shopping list is read flat, and a subtask drawn without its
 * parent is a line that means nothing.
 */
export async function listTasks(
  fetcher: Fetcher,
  endpoint: TodoistEndpoint,
  token: string,
  projectId: string,
): Promise<TodoistResult<readonly TodoistTask[]>> {
  const out: { task: TodoistTask; order: number }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page * PAGE < TODOIST_MAX_ITEMS + PAGE; page++) {
    const answer = await request(
      fetcher,
      endpoint,
      token,
      `/tasks?project_id=${encodeURIComponent(projectId)}&limit=${PAGE}` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`),
    );
    if (!answer.ok) return answer;
    const parsed = parseJson(tasksPage, answer.body);
    if (!parsed.ok) {
      return {
        ok: false,
        message: 'Todoist answered, but not with a list this version can read. An item with no id is refused.',
      };
    }
    for (const one of parsed.value.results) {
      if (one.checked === true || one.is_deleted === true) continue;
      if (one.parent_id !== null && one.parent_id !== undefined) continue;
      out.push({ task: { id: one.id, content: one.content, due: one.due?.date ?? null }, order: one.child_order ?? 0 });
    }
    if (out.length > TODOIST_MAX_ITEMS) {
      return { ok: false, message: `That project has more than ${TODOIST_MAX_ITEMS} items, which is more than a wall reads.` };
    }
    cursor = parsed.value.next_cursor;
    if (cursor === null) break;
  }
  return { ok: true, value: out.sort((a, b) => a.order - b.order).map((one) => one.task) };
}

/** Close a task (done) or reopen it (not done) — the wall's tick, and its correction. */
export async function setTaskDone(
  fetcher: Fetcher,
  endpoint: TodoistEndpoint,
  token: string,
  taskId: string,
  done: boolean,
): Promise<TodoistResult<true>> {
  const answer = await request(fetcher, endpoint, token, `/tasks/${encodeURIComponent(taskId)}/${done ? 'close' : 'reopen'}`, 'POST');
  return answer.ok ? { ok: true, value: true } : answer;
}

/** Add a task to a project — the companion API's add, and nothing else. */
export async function addTask(
  fetcher: Fetcher,
  endpoint: TodoistEndpoint,
  token: string,
  projectId: string,
  content: string,
): Promise<TodoistResult<true>> {
  const answer = await request(fetcher, endpoint, token, '/tasks', 'POST', { content, project_id: projectId });
  return answer.ok ? { ok: true, value: true } : answer;
}
