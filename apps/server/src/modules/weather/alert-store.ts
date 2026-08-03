import type { Severity, Signal, Urgency } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { CapAlert, KnownAlert, Zones } from './alerts.js';

/**
 * Alerts, persisted.
 *
 * They are stored rather than held in memory for two reasons, and both are
 * about a household rather than about tidiness. A display reconnecting in the
 * middle of a tornado warning has to get it from the manifest — waiting for the
 * next push means a wall that reloads during the event shows nothing. And an
 * alert that expires while the network is down still has to clear itself, which
 * needs its `expires` written down somewhere.
 */

export function replaceZones(db: SqliteDatabase, zones: Zones): void {
  const at = Date.now();
  const write = db.transaction(() => {
    /*
     * Rows the location no longer maps to are removed.
     *
     * A household that moves — or corrects a longitude they typed wrong — must
     * stop being warned about the county they used to live in. Leaving the old
     * row would keep polling it for ever, and an alert for somewhere else is
     * worse than no alert: it is wrong and looks right.
     */
    const keep: string[] = [];
    for (const [code, kind] of [
      [zones.forecast, 'forecast'],
      [zones.county, 'county'],
    ] as const) {
      if (code === null) continue;
      keep.push(code);
      db.prepare(
        `INSERT INTO alert_zones (id, code, label, provider, enabled, kind, created_at, updated_at)
         VALUES (?, ?, ?, 'nws', 1, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at`,
      ).run(`zone-${code}`, code, code, kind, at, at);
    }

    if (keep.length === 0) {
      db.prepare(`DELETE FROM alert_zones WHERE provider = 'nws'`).run();
      return;
    }
    const placeholders = keep.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM alert_zones WHERE provider = 'nws' AND code NOT IN (${placeholders})`,
    ).run(...keep);
    // Alerts belonging to a zone nobody watches any more go with it.
    db.prepare(
      `DELETE FROM active_alerts WHERE zone_code IS NOT NULL AND zone_code NOT IN (${placeholders})`,
    ).run(...keep);
  });
  write();
}

export interface ZoneRow {
  readonly id: string;
  readonly code: string;
  readonly kind: string;
  readonly etag: string | null;
}

export function readZones(db: SqliteDatabase): ZoneRow[] {
  return db
    .prepare(
      `SELECT id, code, kind, etag FROM alert_zones
        WHERE provider = 'nws' AND enabled = 1 ORDER BY kind, code`,
    )
    .all() as ZoneRow[];
}

export function recordZonePoll(
  db: SqliteDatabase,
  code: string,
  etag: string | null,
  error: string | null,
): void {
  db.prepare(
    `UPDATE alert_zones
        SET etag = COALESCE(?, etag), last_polled_at = ?, last_error = ?, updated_at = ?
      WHERE code = ?`,
  ).run(etag, Date.now(), error, Date.now(), code);
}

/** What is already held for a zone, for the dedupe. */
export function knownAlerts(db: SqliteDatabase, zoneCode: string): KnownAlert[] {
  return db
    .prepare(`SELECT external_id AS id, sent FROM active_alerts WHERE zone_code = ?`)
    .all(zoneCode) as KnownAlert[];
}

export function applyAlerts(
  db: SqliteDatabase,
  upsert: readonly CapAlert[],
  remove: readonly string[],
): void {
  const at = Date.now();
  const insert = db.prepare(
    `INSERT INTO active_alerts
       (id, external_id, sent, message_type, zone_code, event, headline, description,
        instruction, area_desc, sender_name, severity, urgency, certainty,
        onset_at, expires_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET
       sent = excluded.sent, message_type = excluded.message_type,
       event = excluded.event, headline = excluded.headline,
       description = excluded.description, instruction = excluded.instruction,
       area_desc = excluded.area_desc, sender_name = excluded.sender_name,
       severity = excluded.severity, urgency = excluded.urgency,
       certainty = excluded.certainty, onset_at = excluded.onset_at,
       expires_at = excluded.expires_at, fetched_at = excluded.fetched_at`,
  );
  const drop = db.prepare('DELETE FROM active_alerts WHERE external_id = ?');

  const write = db.transaction(() => {
    for (const id of remove) drop.run(id);
    for (const alert of upsert) {
      insert.run(
        // A stable row id from the CAP identifier, so an Update replaces rather
        // than accumulates.
        `alert-${alert.id}`,
        alert.id,
        alert.sent,
        alert.messageType,
        alert.zoneCode,
        alert.event,
        alert.headline,
        alert.description,
        alert.instruction,
        alert.areaDesc,
        alert.senderName,
        alert.severity,
        alert.urgency,
        alert.certainty,
        alert.onsetAt,
        alert.expiresAt,
        at,
      );
    }
  });
  write();
}

/**
 * Drop what has run out.
 *
 * The evaluator already refuses to fire an expired signal, so this is only
 * housekeeping — but without it a wall that loses its connection during a storm
 * accumulates every warning of the week and hands them all to the manifest.
 */
export function expireAlerts(db: SqliteDatabase, now: number): number {
  return db
    .prepare('DELETE FROM active_alerts WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .run(now).changes;
}

interface AlertRow {
  readonly externalId: string;
  readonly event: string;
  readonly headline: string | null;
  readonly areaDesc: string | null;
  readonly senderName: string | null;
  readonly severity: string | null;
  readonly urgency: string | null;
  readonly certainty: string | null;
  readonly onsetAt: number | null;
  readonly expiresAt: number | null;
  readonly description: string | null;
  readonly instruction: string | null;
}

const SEVERITIES: readonly string[] = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const URGENCIES: readonly string[] = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];

/**
 * Alerts, as signals for the rules.
 *
 * The instruction is folded into the headline because it is the most useful
 * line a warning carries — "move to an interior room on the lowest floor" is
 * what somebody standing in a kitchen needs, and the event name alone is not.
 */
export function alertSignals(db: SqliteDatabase, now: number): Signal[] {
  const rows = db
    .prepare(
      `SELECT external_id AS externalId, event, headline, area_desc AS areaDesc,
              sender_name AS senderName, severity, urgency, certainty,
              onset_at AS onsetAt, expires_at AS expiresAt, description, instruction
         FROM active_alerts
        WHERE expires_at IS NULL OR expires_at > ?
        ORDER BY expires_at`,
    )
    .all(now) as AlertRow[];

  return rows.map((row) => {
    const headline = row.instruction ?? row.headline ?? row.description;
    return {
      source: 'nws' as const,
      key: row.externalId,
      title: row.event,
      ...(headline !== null ? { headline } : {}),
      ...(row.areaDesc !== null ? { area: row.areaDesc } : {}),
      ...(row.senderName !== null ? { sender: row.senderName } : {}),
      severity: (row.severity !== null && SEVERITIES.includes(row.severity)
        ? row.severity
        : 'Unknown') as Severity,
      urgency: (row.urgency !== null && URGENCIES.includes(row.urgency)
        ? row.urgency
        : 'Unknown') as Urgency,
      // Onset is when it began, which is what a dwell would measure against.
      since: row.onsetAt,
      expiresAt: row.expiresAt,
    };
  });
}

/** Every live alert identifier, so dismissals for dead ones can be pruned. */
export function liveAlertKeys(db: SqliteDatabase, now: number): string[] {
  const rows = db
    .prepare(
      `SELECT external_id AS externalId FROM active_alerts
        WHERE expires_at IS NULL OR expires_at > ?`,
    )
    .all(now) as { externalId: string }[];
  return rows.map((row) => row.externalId);
}
