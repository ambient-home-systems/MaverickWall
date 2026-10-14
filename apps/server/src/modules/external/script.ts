import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { configField, secretField } from './recipe.js';
import { readBody, type SourceFormat } from './source-formats.js';

/**
 * A script module's manifest and the one door its code has to the world (RFC
 * 017, plan item M7.12).
 *
 * A script module is a single file of JavaScript that this server runs inside a
 * QuickJS interpreter compiled to WebAssembly, in a worker thread of its own
 * (`sandbox.ts`). Its only output is Panel Data and signals, validated by the
 * same schemas a service module's bodies are, so it can do nothing on a wall a
 * recipe or a service cannot. What it adds is computation between the fetch and
 * the data — arithmetic, conditions, loops, merging two feeds — which a recipe
 * refuses because it is deliberately not a language.
 *
 * Everything that decides what a script may reach is here, in the main thread
 * and outside the sandbox: the hosts it declared, which secret goes to which
 * host, the network policy and the limits. The interpreter is handed answers and
 * never a socket, a secret or a file.
 */

/**
 * The limits of one run (RFC 017 §4.1). Interpreter memory and CPU are the
 * interpreter's own (its memory limit and its interrupt handler); the wall time
 * is the main thread's, which terminates the worker. CPU is interpreter time
 * only, so a script waiting on a slow host is not charged for it.
 */
export const SCRIPT_LIMITS = {
  memoryBytes: 16 * 1024 * 1024,
  cpuMs: 200,
  wallMs: 10_000,
  /** QuickJS's own stack, so a deep recursion ends as an error rather than a crash. */
  stackBytes: 512 * 1024,
  fetches: 5,
  responseBytes: 1024 * 1024,
  /** What a run may hand back, before any schema reads it. */
  outputBytes: 256 * 1024,
} as const;

/** The longest source stored: a script module is one readable file, not a bundle. */
export const MAX_SOURCE_BYTES = 64 * 1024;

/**
 * A host a script may contact: a lower-case DNS name or an IPv4 address, with
 * no port and no path. Compared with the request's own hostname, exactly — a
 * script that declared `api.example.com` may not reach `evil.api.example.com`.
 */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const hostName = z.string().regex(HOST, 'a host name, such as api.example.com');

export const scriptManifestSchema = z
  .object({
    name: z.string().min(1).max(60),
    contract: z.literal(1),
    /** Every host the script may fetch from. Shown to the household before install. */
    hosts: z.array(hostName).max(8).default([]),
    config: z.array(configField).max(8).default([]),
    /** As a recipe's, and each bound to one declared host it alone is sent to. */
    secrets: z.array(secretField.extend({ host: hostName }).strict()).max(8).default([]),
    intervalSeconds: z.number().int().min(60).max(86_400).default(900),
    /**
     * Off by default: a script reaches the public internet over https only. On,
     * its declared hosts may be on the household's own network, by plain http.
     * Refused in the store; a household turns it on by pasting it themselves.
     */
    allowLan: z.boolean().default(false),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.hosts).size !== manifest.hosts.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hosts'], message: 'a host is listed twice' });
    }
    const keys = [...manifest.config.map((f) => f.key), ...manifest.secrets.map((s) => s.key)];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config'], message: 'two settings or secrets share a key' });
    }
    manifest.secrets.forEach((secret, i) => {
      if (!manifest.hosts.includes(secret.host)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secrets', i, 'host'],
          message: `the secret “${secret.key}” is for ${secret.host}, which is not one of the hosts`,
        });
      }
    });
  });

export type ScriptManifest = z.infer<typeof scriptManifestSchema>;

/** A script's source: text, under the cap, with an `export default` somewhere in it. */
export const scriptSourceSchema = z
  .string()
  .min(1, 'the script is empty')
  .refine((source) => Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES, {
    message: `a script is at most ${MAX_SOURCE_BYTES / 1024} KB`,
  })
  .refine((source) => /\bexport\s+default\b/.test(source), { message: 'the script has no export default' });

/** The source's sha256, shown on the module's card so a household can tell one version from another. */
export function scriptSha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** The fetcher's policy for a script: public https only, unless the household allowed its LAN. */
export function scriptPolicy(manifest: ScriptManifest): {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  allowLoopback: boolean;
} {
  const lan = manifest.allowLan;
  return { allowHttp: lan, allowPrivateNetwork: lan, allowLoopback: lan };
}

// ---------------------------------------------------------------------------
// A request from inside the sandbox
// ---------------------------------------------------------------------------

/**
 * What a script's `ctx.fetch(url, options)` asks for, as the sandbox hands it
 * across. Read with a schema like any stranger's body: the worker is ours, but
 * what it forwards was written by the script.
 */
export const scriptFetchRequestSchema = z
  .object({
    url: z.string().min(1).max(2048),
    options: z
      .object({
        headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'a header name'), z.string().max(512)).optional(),
        /** How to read the answer: as text (the absence), or as a news feed or an XML document, read here. */
        format: z.enum(['text', 'feed', 'xml']).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ScriptFetchRequest = z.infer<typeof scriptFetchRequestSchema>;

/** What the script is handed back: never the response's headers, and never a secret. */
export interface ScriptFetchAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** A feed or a document, read into a plain tree, when `format` asked for one. */
  readonly data?: unknown;
}

const SECRET_PLACEHOLDER = /\{secret:([a-z0-9_]+)\}/g;
const HEADER_LIMIT = 8;

/**
 * A request checked against the manifest, before anything leaves: the host is
 * one it declared, the address carries no secret, and each `{secret:key}` in a
 * header is filled in only when the request goes to the host that secret was
 * declared for. The script names the secret and never sees its value.
 */
export function prepareScriptFetch(
  manifest: ScriptManifest,
  secrets: Readonly<Record<string, string>>,
  request: ScriptFetchRequest,
): { ok: true; url: string; headers: Record<string, string>; format: 'text' | SourceFormat } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, error: 'That is not an address.' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'An address may not carry a password.' };
  if (!manifest.hosts.includes(url.hostname)) {
    return { ok: false, error: `${url.hostname} is not one of this module’s hosts.` };
  }
  if (/\{secret:/.test(decodeURIComponent(request.url))) {
    return { ok: false, error: 'A secret goes in a header, never in the address.' };
  }
  const headers: Record<string, string> = {};
  const entries = Object.entries(request.options.headers ?? {});
  if (entries.length > HEADER_LIMIT) return { ok: false, error: `At most ${HEADER_LIMIT} headers.` };
  for (const [name, template] of entries) {
    let refused: string | undefined;
    const value = template.replace(SECRET_PLACEHOLDER, (_all, key: string) => {
      const declared = manifest.secrets.find((s) => s.key === key);
      if (declared === undefined) refused ??= `There is no secret called ${key}.`;
      else if (declared.host !== url.hostname) refused ??= `The secret ${key} is for ${declared.host} only.`;
      return secrets[key] ?? '';
    });
    if (refused !== undefined) return { ok: false, error: refused };
    headers[name] = value;
  }
  return { ok: true, url: url.toString(), headers, format: request.options.format === undefined || request.options.format === 'text' ? 'text' : request.options.format };
}

/**
 * The `fetch` a run is given: checked against the manifest, counted against the
 * run's limit, and sent through the SSRF-guarded fetcher (rule four). A refusal
 * — a host it did not declare, a fifth fetch, the LAN without the household's
 * say-so — is thrown into the script as an error it may catch; an answer that
 * is not 2xx is an ordinary answer with `ok: false`, as a browser's is.
 */
export function scriptFetch(
  fetcher: Fetcher,
  manifest: ScriptManifest,
  secrets: Readonly<Record<string, string>>,
  timeLeft: () => number,
): (request: ScriptFetchRequest) => Promise<ScriptFetchAnswer> {
  let count = 0;
  return async (request) => {
    count += 1;
    if (count > SCRIPT_LIMITS.fetches) throw new Error(`A run may fetch at most ${SCRIPT_LIMITS.fetches} times.`);
    const prepared = prepareScriptFetch(manifest, secrets, request);
    if (!prepared.ok) throw new Error(prepared.error);
    const outcome = await fetcher.fetch({
      url: prepared.url,
      policy: scriptPolicy(manifest),
      maxBytes: Math.min(SCRIPT_LIMITS.responseBytes, FETCH_LIMITS.json),
      timeoutMs: Math.max(1, Math.min(10_000, timeLeft())),
      ...(Object.keys(prepared.headers).length > 0 ? { headers: prepared.headers } : {}),
    });
    if (outcome.status === 'rejected') throw new Error(outcome.message);
    if (outcome.status === 'failed') {
      if (outcome.httpStatus !== undefined) return { ok: false, status: outcome.httpStatus, contentType: '', body: '' };
      throw new Error(outcome.message);
    }
    if (outcome.status !== 'ok') throw new Error('The host did not answer.');
    if (prepared.format === 'text') return { ok: true, status: 200, contentType: outcome.contentType, body: outcome.body };
    const read = readBody(prepared.format, outcome.body);
    if (!read.ok) throw new Error(`The answer ${read.why}.`);
    return { ok: true, status: 200, contentType: outcome.contentType, body: outcome.body, data: read.body };
  };
}
