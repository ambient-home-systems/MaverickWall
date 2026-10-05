# RFC 017 — Sandboxed module code

Status: **proposed, nothing built** · Owner: — · First drafted 2026-10-05 ·
Relates to `apps/server/src/modules/external/` (`index.ts`, `recipe.ts`,
`panel-data.ts`, `signal-data.ts`), `apps/server/src/api/external-modules.ts`,
`apps/server/src/net/fetcher.ts`, `apps/server/src/secrets/keyring.ts`,
`apps/server/src/catalog/` · Builds on RFC 001 (service modules) and RFC 002
(recipes) · Plan item M7.12 in
[`plan-2026-10-magic-frame-parity.md`](plan-2026-10-magic-frame-parity.md) ·
Amends no hard rule

## 1. Summary

A **script module** is a third kind of module, beside a service and a recipe:
a single file of JavaScript that Maverick Wall runs **on the server**, inside a
QuickJS interpreter compiled to WebAssembly, and whose only output is Panel Data
and signals. It gets one way out — an SSRF-guarded `fetch` to hosts it declared
in advance — and nothing else.

The wall is untouched. It still receives validated data and draws it with
first-party renderers, so a script module can do nothing on a wall that a
recipe or a service module cannot. What it adds is computation between the
fetch and the data: combining two feeds, arithmetic, conditionals, date
handling, loops over a response — the things a recipe refuses because it is
deliberately not a language.

This RFC is the "server sandbox later" half of decision MD3. It is written now
so the contract 2 work (M7.2–M7.9) does not close off a door this needs. It is
built only after contract 2 ships, and only if a household-shaped need is
found that richer recipes do not meet (§9).

## 2. Why

Magic Frame's custom widgets are code, and they can draw anything. Ours are
data, and they can draw rows or a paragraph. Part 2 of the parity plan closes
most of that gap by making the data richer. What richer data cannot close is
the **transformation** gap: a recipe can pull `bins.next.date` out of a
response, but it cannot work out which of three bin streams is next, convert a
tide table into "high tide in 2 h 10 min", or merge a train API's departures
with its disruption feed.

Today the answer to that is a service module: a process the household writes
and runs. That is the right answer for a developer and the wrong one for
everybody else, and it is the reason the store holds two entries.

## 3. What is rejected, and why

| Option | Why not |
| --- | --- |
| Run uploaded code in the wall's page, as Magic Frame does | Breaks Hard Rule 3 and the "data, never code" contract of RFC 001. Magic Frame's modules run with the admin's session when a view is opened in a signed-in browser. |
| A sandboxed `<iframe>` on the wall | Cannot draw on e-paper, cannot follow the legibility rules (density tiers, arc-minute roles), works against offline-first, and fights the CSP. Excluded by MD3. |
| `node:vm` | Not a security boundary; Node's own documentation says so. |
| `isolated-vm` | A real isolate, but a native addon: a second `better-sqlite3`-shaped multi-arch build risk, for one feature. |
| A richer recipe language | Every step towards expressions in recipes is a step towards an interpreter we write and secure ourselves. If we need a language, use a sandboxed real one. |

## 4. Design

### 4.1 The runtime

- **QuickJS compiled to WASM** (candidate: `quickjs-emscripten`; licence,
  maintenance and size to be verified when this is built). It lives in
  `apps/server` only; `packages/core` and `packages/calendar` stay free of it
  (Hard Rule 1).
- Each run happens in a **`worker_thread` with `resourceLimits`**, so an
  interpreter bug, an infinite loop or a memory blow-up kills the worker and
  never the process (Hard Rule 9).
- A **fresh context per run.** No state carries from one run to the next.
- Limits per run, enforced by the interpreter's memory limit and interrupt
  handler and by the worker: memory 16 MB, CPU 200 ms of interpreter time,
  wall time 10 s including fetches, at most 5 fetches, at most 1 MB per
  response. Numbers to be measured on an arm64 Pi before they are fixed (§8).

### 4.2 What a script receives

```js
export default async function run(ctx) {
  const res = await ctx.fetch('https://api.example.com/bins?street={street}');
  const data = await res.json();
  return { panel: { kind: 'readings', title: 'Bins', items: [/* … */] } };
}
```

| On `ctx` | What it is |
| --- | --- |
| `config` | The widget's own settings (M7.6), already validated against the module's declared fields. |
| `fetch(url, options?)` | Calls `Fetcher` (Hard Rule 4). The host must be in the module's declared `hosts`. https only, unless the household granted the LAN opt-in for this module. `{secret}` placeholders are filled in by the host, in headers only, and only for the host the secret was declared for. |
| `now` | The server's clock, as an instant. |
| `timeZone` | The household's zone. |

There is no file system, no network beyond `fetch`, no timers beyond the run,
no access to other modules, and no way to read a secret's value.

### 4.3 What a script returns

`{ panel?, signals? }`. `panel` is validated with `panelDataSchema` (contract 2
once it exists) and `signals` with `signalDataSchema`, exactly as a service
module's bodies are. Anything that does not fit is **rejected, not coerced**
(Hard Rule 5): the wall keeps the last good panel and the Add-ons screen shows
the reason.

### 4.4 Declaring a module

The manifest is a recipe's, minus `fetch` and `panel`, plus:

- `hosts`: the hosts it may contact. Shown to the household before install, in
  the same consent shape as the update check: "This module may contact
  api.example.com."
- `secrets`: as recipes declare them today, each bound to one declared host.
- `allowLan`: as recipes declare it; refused for anything that did not come
  from the household's own paste.

The source is stored in `external_modules` beside the manifest, with its
sha256 shown on the Add-ons screen, under a new `kind = 'script'`. A migration
widens nothing else.

### 4.5 Where scripts come from

- **The store**, by pull request, as recipes are today: reviewed, versioned
  with the image, available offline.
- **Pasted on the Advanced screen**, by the household, for their own use.
  There are no remote catalogues (they were removed with migration `0020`).

### 4.6 Errors and logs

A thrown error or a refused output becomes the module's `last_error`, capped
and stripped like every other stranger's string. Logs carry the module id and
the host, never the response body or the panel's contents (the existing rule
for event content and credentials).

## 5. Threats

| Threat | Mitigation |
| --- | --- |
| Sandbox escape through an interpreter bug | WASM boundary, a worker with resource limits, no host functions except `fetch`, the dependency kept current and audited like everything in the image. |
| Exfiltrating a secret | The script never sees a secret's value; the host injects it into a header, only for the host it was declared for. |
| Reaching the LAN or `supervisor` | `Fetcher`'s SSRF guard; the LAN opt-in is the household's, per module, and refused from the store. |
| Calling a host it did not declare | Refused before the request leaves. |
| Denial of service (loops, memory, huge output) | Interrupt handler, memory limit, worker limits, output size cap. |
| A store script changing behaviour silently | Stored source and its hash change only with a release or a household's own paste. |

## 6. Interaction with the hard rules

- **Rule 1** — the runtime is in `apps/server`; core stays dependency-free.
- **Rule 3** — nothing new reaches the wall: it still receives data only.
- **Rule 4** — every request goes through `Fetcher`.
- **Rule 5** — output through the existing schemas, rejected not coerced.
- **Rule 6** — secrets sealed with the keyring, never readable by a script, never logged.
- **Rule 8** — in-process, in a worker thread; no second container.
- **Rule 9** — a failing script costs its own panel, never the wall.

## 7. Tests

Written before the runtime is wired in, each one red against a naive runner:

- An infinite loop, a memory bomb, and a deep recursion each end the run and
  leave the process and the other modules polling.
- A fetch to a loopback, link-local or RFC 1918 address is refused without the
  opt-in, by `Fetcher` — and a fetch to an undeclared public host is refused
  before it.
- A script that tries to read a secret (by `ctx` inspection, by echoing a
  header back from a host it controls) never sees the value.
- An oversized, misshapen or extra-key output is rejected and the last good
  panel stays on the wall.
- Two scripts cannot see each other's state, and one run cannot see the last.
- A real hostile fixture, not an invented one, for each, in the repository's
  own tradition.

## 8. Measurement gate

Before any limit is fixed: interpreter start and a typical run (one fetch,
50 rows of arithmetic) timed on an arm64 Pi 4 and on the CI runner, and the
image-size cost of the WASM blob recorded. If a run cannot complete in well
under a second of CPU on a Pi, the feature does not ship.

## 9. When to build it

Only after contract 2 (M7.2–M7.9) has shipped, and only when there is at least
one store entry that a richer recipe cannot express and that a household
asked for. If none appears, this RFC stays proposed, which is a fine outcome.

## 10. Open questions

- Should a script be able to keep a small amount of state between runs (for
  "changed since last poll")? Proposed: no, until a real module needs it.
- TypeScript in the store: compile at review time, or ship JavaScript only?
  Proposed: JavaScript only in the stored source; a scaffold may use TS and
  emit JS.
- Is 5 fetches per run enough for the store entries we know of (trains with
  disruptions, bins with holiday overrides)? To be checked against the seed
  list in M7.11.
