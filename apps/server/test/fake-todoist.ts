import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A stand-in for Todoist's API v1 (plan item M5.7), on loopback.
 *
 * Built from the OpenAPI description Todoist's documentation embeds, not from
 * memory: `GET /api/v1/projects` and `GET /api/v1/tasks` answer
 * `{ results, next_cursor }` and page by `cursor` (at most `limit`, 200);
 * `GET /tasks` answers open tasks only; `POST /tasks/{id}/close` and
 * `/reopen` answer 200, and 404 for a task that is not there; `POST /tasks`
 * takes `content` and `project_id`. Every request without the right Bearer
 * token answers 401 with Todoist's own error body. A task carries the many
 * fields Todoist sends that the reader strips, so the parse is tested against
 * a realistic body rather than a minimal one.
 *
 * Every request is recorded, method and path, so a test can say that nothing
 * outside the five calls left the server.
 */

export interface FakeTask {
  id: string;
  project_id: string;
  content: string;
  checked: boolean;
  parent_id: string | null;
  child_order: number;
  due: { date: string; string: string; is_recurring: boolean } | null;
}

export interface FakeTodoist {
  readonly base: string;
  /** Mutable, so a test can rotate it the way a household resetting it in Todoist would. */
  token: string;
  readonly projects: { id: string; name: string; is_archived: boolean }[];
  readonly tasks: FakeTask[];
  readonly requests: { method: string; path: string; body: string; authorization: string | undefined }[];
  /** A status every request answers with instead, while set. */
  failWith: number | undefined;
  /** A status the task list alone answers with, while set — the projects still read. */
  failTasks: number | undefined;
  /** How many results a page holds, to make a small list page. */
  pageSize: number | undefined;
  close(): Promise<void>;
}

export async function fakeTodoist(token = 'todoist-test-token-0123456789abcdef'): Promise<FakeTodoist> {
  const state = {
    base: '',
    token,
    projects: [] as FakeTodoist['projects'],
    tasks: [] as FakeTask[],
    requests: [] as FakeTodoist['requests'],
    failWith: undefined as number | undefined,
    failTasks: undefined as number | undefined,
    pageSize: undefined as number | undefined,
  };
  let nextId = 9_000;
  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const full = (task: FakeTask) => ({
    user_id: '1',
    id: task.id,
    project_id: task.project_id,
    section_id: null,
    parent_id: task.parent_id,
    added_by_uid: '1',
    assigned_by_uid: null,
    responsible_uid: null,
    labels: [],
    deadline: null,
    duration: null,
    is_collapsed: false,
    checked: task.checked,
    is_deleted: false,
    added_at: '2026-10-06T09:00:00Z',
    completed_at: null,
    completed_by_uid: null,
    updated_at: '2026-10-06T09:00:00Z',
    due: task.due,
    priority: 1,
    child_order: task.child_order,
    order_key: null,
    content: task.content,
    description: '',
    note_count: 0,
    day_order: -1,
    completed_count: 0,
    postponed_count: 0,
  });
  const page = <T>(all: T[], url: URL): { results: T[]; next_cursor: string | null } => {
    const limit = Math.min(state.pageSize ?? Number(url.searchParams.get('limit') ?? 50), 200);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const results = all.slice(start, start + limit);
    return { results, next_cursor: start + limit < all.length ? String(start + limit) : null };
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://localhost');
      state.requests.push({ method: request.method ?? '', path: url.pathname, body, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${state.token}`) {
        send(response, 401, { error: 'Unauthorized', error_code: 477, error_tag: 'UNAUTHORIZED', http_code: 401 });
        return;
      }
      if (state.failWith !== undefined) {
        send(response, state.failWith, { error: 'Failed', http_code: state.failWith });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
        send(response, 200, page(state.projects.map((p) => ({ ...p, is_deleted: false, child_order: 0 })), url));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/tasks' && state.failTasks !== undefined) {
        send(response, state.failTasks, { error: 'Failed', http_code: state.failTasks });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/tasks') {
        const project = url.searchParams.get('project_id');
        const open = state.tasks.filter((task) => !task.checked && (project === null || task.project_id === project));
        send(response, 200, page(open.map(full), url));
        return;
      }
      const action = /^\/api\/v1\/tasks\/([^/]+)\/(close|reopen)$/.exec(url.pathname);
      if (request.method === 'POST' && action !== null) {
        const task = state.tasks.find((one) => one.id === decodeURIComponent(action[1] as string));
        if (task === undefined) {
          send(response, 404, { error: 'Task not found', http_code: 404 });
          return;
        }
        task.checked = action[2] === 'close';
        send(response, 200, {});
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/tasks') {
        const parsed = JSON.parse(body) as { content: string; project_id: string };
        const task: FakeTask = {
          id: String(nextId++),
          project_id: parsed.project_id,
          content: parsed.content,
          checked: false,
          parent_id: null,
          child_order: 99,
          due: null,
        };
        state.tasks.push(task);
        send(response, 200, full(task));
        return;
      }
      send(response, 404, { error: 'Not found', http_code: 404 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/api/v1`;
  return Object.assign(state, {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
