import { validateOutboundUrl } from '@maverick-wall/core';
import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';

/**
 * Creating a calendar source.
 *
 * Extracted from the `add-source` tool so the wizard and the command line
 * share one implementation. Two copies of this would drift, and the half that
 * drifts is the one that forgets to schedule the sync — leaving a source that
 * exists, looks configured, and never fetches anything.
 */

export interface AddSourceInput {
  readonly name: string;
  readonly url: string;
  readonly allowPrivateNetwork?: boolean;
  readonly allowLoopback?: boolean;
  readonly allowHttp?: boolean;
}

export type AddSourceResult =
  | { readonly ok: true; readonly id: string; readonly host: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Validate, store encrypted, and schedule the first sync.
 *
 * The URL goes through the same guard the fetcher uses — rule four — and is
 * stored as a keyring envelope. Only the hostname is kept in clear, because
 * the path is the credential.
 */
export function addCalendarSource(
  db: SqliteDatabase,
  keyring: Keyring,
  input: AddSourceInput,
): AddSourceResult {
  const policy = {
    ...(input.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(input.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(input.allowHttp === true ? { allowHttp: true } : {}),
  };

  const validated = validateOutboundUrl(input.url, policy);
  if (!validated.ok) {
    return { ok: false, code: validated.error.code, message: validated.error.message };
  }

  const id = randomBytes(8).toString('hex');
  const now = Date.now();

  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, url_encrypted, url_host, allow_private_network, allow_loopback,
        allow_http, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    keyring.encrypt(input.url, 'calendar-source-url'),
    validated.value.hostname,
    input.allowPrivateNetwork === true ? 1 : 0,
    input.allowLoopback === true ? 1 : 0,
    input.allowHttp === true ? 1 : 0,
    now,
    now,
  );

  // A few seconds out rather than immediately, so adding several in a row does
  // not fire them all at once.
  db.prepare(
    `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
     VALUES (?, 'ics-sync', ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
  ).run(`ics-sync:${id}`, now + 3_000, now, now);

  return { ok: true, id, host: validated.value.hostname };
}
