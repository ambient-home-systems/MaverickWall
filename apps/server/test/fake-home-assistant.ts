import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A Home Assistant that is real enough to be wrong in the same ways.
 *
 * Lifted out of `homeassistant.test.ts` when `ha-write-boundary.test.ts` needed
 * the same house. A second fake would have been a second account of what Home
 * Assistant answers, which is the shape of bug this repository keeps finding —
 * two readers of one stored value, two renderers of one canvas. There is one
 * house here and both files drive it.
 *
 * It refuses without a bearer token, exactly as Core does, because "did we
 * actually attach the credential" is the single most likely thing to be
 * silently broken and a permissive fake would never catch it. And it answers
 * `404` the way the real one does, which is how the missing `/api` prefix was
 * found in the first place.
 */

const servers: Server[] = [];

/** Close every fake this module has stood up. Call it from `afterAll`. */
export async function closeFakeHomeAssistants(): Promise<void> {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

/** The token a household would paste in. Asserted absent from several places. */
export const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.a-long-lived-access-token-that-controls-the-house.sig';

/**
 * Dated relative to now.
 *
 * A fixture pinned to a date stops being inside the sync window the moment
 * that date passes, and the test would then assert against an empty calendar
 * and quietly prove nothing.
 */
export function inDays(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The states document, in Home Assistant's own shape.
 *
 * Includes one entity from an unsupported domain, because filtering it is a
 * behaviour rather than an accident, and one with no device class.
 */
export function statesBody(kitchen = '19.4', freezerChangedAt = new Date(Date.now() - 9 * 60_000)): string {
  return JSON.stringify([
    {
      entity_id: 'sensor.kitchen_temperature',
      state: kitchen,
      attributes: {
        unit_of_measurement: '°C',
        device_class: 'temperature',
        friendly_name: 'Kitchen temperature',
      },
      last_changed: new Date(Date.now() - 120_000).toISOString(),
      last_updated: new Date(Date.now() - 120_000).toISOString(),
      context: { id: '01H', parent_id: null, user_id: null },
    },
    {
      entity_id: 'binary_sensor.freezer_door',
      state: 'on',
      attributes: { device_class: 'door', friendly_name: 'Freezer door' },
      last_changed: freezerChangedAt.toISOString(),
      last_updated: freezerChangedAt.toISOString(),
      context: { id: '01J', parent_id: null, user_id: null },
    },
    {
      entity_id: 'binary_sensor.under_sink',
      state: 'off',
      attributes: { device_class: 'moisture', friendly_name: 'Under the sink' },
      last_changed: new Date(Date.now() - 86_400_000).toISOString(),
      last_updated: new Date(Date.now() - 86_400_000).toISOString(),
      context: { id: '01K', parent_id: null, user_id: null },
    },
    {
      // Not a reading. Must never reach the picker or the wall.
      entity_id: 'automation.morning_routine',
      state: 'on',
      attributes: { friendly_name: 'Morning routine' },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      context: { id: '01L', parent_id: null, user_id: null },
    },
    // The two to-do lists, as `/api/states` lists them (RFC 012). The state is
    // the *count* of open items and the items are not in the attributes at all
    // — which is the whole reason a list is not a reading. Not a reading
    // either, so the readings picker must leave these out too.
    ...Object.keys(TODO_LISTS).map((entityId) => todoStateBody(entityId)),
  ]);
}

/**
 * The lists this house has, and what they can do.
 *
 * `supported_features` is the affordance: bit 4 is `UPDATE_TODO_ITEM`, and the
 * read-only list has it **clear**. A fixture with only tickable lists cannot
 * see a renderer that draws a box on a list core would refuse to update.
 */
const TODO_LISTS: Readonly<Record<string, { name: string; features: number }>> = {
  // CREATE | DELETE | UPDATE | MOVE — a `local_todo` list.
  'todo.shopping': { name: 'Shopping', features: 15 },
  // CREATE only — a list an integration exposes but will not let anyone tick.
  'todo.read_only': { name: 'Read only', features: 1 },
};

/** One list's state document, the shape `GET /api/states/<entity>` answers. */
export function todoStateBody(entityId: string): {
  entity_id: string;
  state: string;
  attributes: { friendly_name: string; supported_features: number; icon: string };
  last_changed: string;
  last_updated: string;
  context: { id: string; parent_id: null; user_id: null };
} {
  const list = TODO_LISTS[entityId] ?? { name: entityId, features: 0 };
  return {
    entity_id: entityId,
    state: '2',
    attributes: { friendly_name: list.name, supported_features: list.features, icon: 'mdi:clipboard-list' },
    last_changed: new Date(Date.now() - 300_000).toISOString(),
    last_updated: new Date(Date.now() - 300_000).toISOString(),
    context: { id: '01M', parent_id: null, user_id: null },
  };
}

export interface FakeHa {
  base: string;
  /** Every Authorization header seen, so the token can be proven to arrive. */
  readonly seen: string[];
  /** Every path requested, in order. */
  readonly paths: string[];
  /**
   * Every POST, as `{ path, body }` — the path with its query string stripped,
   * so it can be compared against `HA_SERVICES` directly.
   *
   * This is the whole runtime half of the write boundary: the constant says
   * what may be called, and this says what actually was. A source scan alone
   * cannot see a path built by string concatenation from somewhere else.
   */
  readonly posts: { path: string; query: string; body: string }[];
  down: boolean;
  /**
   * Refuse `todo.get_items` alone, with the 500 an integration that is
   * reloading answers. Everything else keeps working, which is the case a
   * list's *first* read failing on the admin page actually is: the house is
   * up, the picker filled, and one list would not read.
   */
  refuseItems: boolean;
  kitchen: string;
  /**
   * The two lists this house has. One of them cannot be updated — bit 4 of
   * `supported_features` is clear — because the read-only list is the case the
   * widget's whole affordance rule rests on, and a fixture with only tickable
   * lists cannot see it.
   */
  readonly todo: Record<string, { items: { uid: string; summary: string; status: string }[] }>;
  /** Stand the fake down without reaching into a module-level array. */
  close(): Promise<void>;
}

export async function fakeHomeAssistant(): Promise<FakeHa> {
  const state: FakeHa = {
    base: '',
    seen: [],
    paths: [],
    posts: [],
    down: false,
    refuseItems: false,
    kitchen: '19.4',
    todo: {
      'todo.shopping': {
        items: [
          { uid: 'i-1', summary: 'Milk', status: 'needs_action' },
          // Twice, with different uids. `_find_by_uid_or_summary` matches
          // `value in (item.uid, item.summary)` and returns the *first* hit, so
          // a fixture with unique summaries cannot see a renderer that ticks by
          // name — it would be right by accident.
          { uid: 'i-2', summary: 'Milk', status: 'needs_action' },
          { uid: 'i-3', summary: 'Bread', status: 'completed' },
        ],
      },
      'todo.read_only': {
        items: [{ uid: 'r-1', summary: 'Nothing to be done here', status: 'needs_action' }],
      },
    },
    close: async () => {},
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    state.paths.push(url);
    state.seen.push(request.headers.authorization ?? '');

    if (state.down) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"message":"bad gateway"}');
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"message":"Unauthorized"}');
      return;
    }

    const json = (body: string): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    };

    if (url === '/api/') return json('{"message":"API running."}');
    if (url === '/api/states/zone.home') {
      return json(
        JSON.stringify({
          entity_id: 'zone.home',
          state: 'zoning',
          attributes: { latitude: 38.8894, longitude: -77.0352, friendly_name: 'Home' },
        }),
      );
    }
    if (url === '/api/states') return json(statesBody(state.kitchen));
    // One list's own state — `supported_features` lives here and nowhere else,
    // since `get_items` does not return it. A list this house has not got is a
    // 404 with Home Assistant's own sentence, which is what a list deleted on
    // somebody's phone answers with.
    if (url.startsWith('/api/states/todo.')) {
      const entityId = decodeURIComponent(url.slice('/api/states/'.length));
      if (state.todo[entityId] === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"message":"Entity not found."}');
        return;
      }
      return json(JSON.stringify(todoStateBody(entityId)));
    }
    if (url === '/api/calendars') {
      return json(JSON.stringify([{ entity_id: 'calendar.family', name: 'Family' }]));
    }
    if (url.startsWith('/api/calendars/calendar.family')) {
      return json(
        JSON.stringify([
          {
            // An all-day event. `end` is the day *after* the last day it
            // occupies — the same promise ICS makes, and the same trap.
            summary: 'Bin day',
            start: { date: inDays(3) },
            end: { date: inDays(4) },
            description: '',
            location: '',
            uid: 'bin-1',
          },
          {
            summary: 'Swimming',
            start: { dateTime: `${inDays(2)}T17:30:00+00:00` },
            end: { dateTime: `${inDays(2)}T18:30:00+00:00` },
            uid: 'swim-1',
          },
        ]),
      );
    }

    /*
     * Service calls, answered the way Core answers them.
     *
     * The `?return_response` refusal is the important one and it is quoted
     * verbatim: Home Assistant refuses a service call that answers with data
     * unless the caller asked for the answer, with a bare 400 and the whole
     * diagnosis in the prose. A fake that answered anyway would let a request
     * that is wrong in production pass here.
     */
    if (url.startsWith('/api/services/')) {
      const [rawPath, query = ''] = url.split('?');
      const service = (rawPath ?? '').slice('/api/services/'.length);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        state.posts.push({ path: rawPath ?? '', query, body });

        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end('{"message":"Invalid JSON specified"}');
          return;
        }

        const entity = typeof parsed['entity_id'] === 'string' ? parsed['entity_id'] : '';
        const list = state.todo[entity];

        if (service === 'todo/get_items') {
          if (state.refuseItems) {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end('{"message":"Unknown error"}');
            return;
          }
          if (query !== 'return_response') {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
              '{"message":"Service call requires responses but caller did not ask for responses"}',
            );
            return;
          }
          if (list === undefined) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(`{"message":"Entity ${entity} does not exist"}`);
            return;
          }
          /*
           * The status filter, honoured the way core honours it: absent means
           * `needs_action` alone, which is exactly why the caller has to name
           * both — a reader relying on the default would never see a completed
           * item and `showDone` would be a switch that does nothing.
           */
          const wanted = Array.isArray(parsed['status'])
            ? (parsed['status'] as unknown[]).filter((s): s is string => typeof s === 'string')
            : ['needs_action'];
          const items = list.items.filter((item) => wanted.includes(item.status));
          json(JSON.stringify({ changed_states: [], service_response: { [entity]: { items } } }));
          return;
        }

        if (service === 'todo/update_item') {
          if (entity === 'todo.read_only') {
            // What core does when `required_features` is not satisfied.
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
              `{"message":"Entity ${entity} does not support this service."}`,
            );
            return;
          }
          const item = list?.items.find((candidate) => candidate.uid === parsed['item']);
          if (item === undefined) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end('{"message":"Unable to find to-do list item: unknown"}');
            return;
          }
          if (typeof parsed['status'] === 'string') item.status = parsed['status'];
          json('{"changed_states":[]}');
          return;
        }

        // Every other service. A real Home Assistant would happily run these;
        // this one records the attempt and refuses, so a test asserting the
        // allowlist has something to assert against.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(`{"message":"Service ${service} not permitted by this fixture"}`);
      });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"message":"Not found"}');
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  // Not "down" — gone. A 502 comes from a server; this is no server at all,
  // and that is a different failure with a different message.
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

