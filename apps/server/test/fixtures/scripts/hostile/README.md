# Hostile scripts

What RFC 017 §7 asks a script module's sandbox to survive, written as the
attacks have been published against other JavaScript sandboxes rather than
invented for this one. Each is run by `test/script-sandbox.test.ts`, which
holds the run to ending with the right reason and the server to carrying on.

| File | The attack | Where it comes from |
| --- | --- | --- |
| `loop.js` | A loop that never ends | The first thing anybody tries |
| `memory.js` | An array doubled until the heap is gone | "Billion laughs", the doubling shape of XML entity expansion |
| `recursion.js` | Recursion with no base case | Stack exhaustion, which crashes an interpreter without a stack limit |
| `redos.js` | `/(a+)+$/` against a near match | Catastrophic backtracking (OWASP's ReDoS page uses this very pattern) |
| `escape-constructor.js` | `ctx.fetch.constructor.constructor('return this')()` | The `this.constructor.constructor('return process')()` escape from Node's `vm`, which Node's own documentation warns is not a security boundary |
| `escape-rejection.js` | Reaching the host through an error a host call threw | vm2's escapes through host errors and promise rejections (CVE-2023-29017, CVE-2023-37466) |
| `pollute.js` | `Object.prototype` and `globalThis` written for the next run to find | Prototype pollution, and state left for a later run |
| `never.js` | A promise that never settles | A run that waits for ever without spending CPU |
| `huge-output.js` | A panel of several megabytes | Output that would sit in the database and every manifest |
| `secret-hunt.js` | Every property of `ctx`, its functions' source, and a header echoed back | Credential exfiltration from a sandbox's host object |
