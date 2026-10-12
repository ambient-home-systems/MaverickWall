import { describe, expect, it } from 'vitest';

import { haReadingHandle, type Manifest } from '../src/api/manifest.js';
import { panelInput, renderFreeformEpaper } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { bitString } from './epaper-frame.js';

/**
 * The now-playing card (plan item M6.9) and the Notifications widget (plan
 * item M6.11) on a one-bit panel, asked by decoding frames.
 *
 *  - The card draws the player it follows and what it plays, so a new song is
 *    a new frame — and where the track has got to is no input at all, so a
 *    song playing on is the same frame for as long as it plays. No sleeve.
 *  - The widget draws a rule's tile and Home Assistant's notification as
 *    lines, the second only while the widget shows them, as many as `count`.
 */

const W = 800;
const H = 480;
const PLAYER = haReadingHandle('media_player.kitchen');

function manifestOf(panels: Record<string, unknown>): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 9, 12, 15, 30),
    window: { from: '2026-10-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [{ date: '2026-10-12', shifts: [], events: [] }],
    sources: [],
    panels,
  } as unknown as Manifest;
}

function house(media: Record<string, unknown>, tone: string | null = 'active'): Record<string, unknown> {
  return {
    home: {
      readings: [
        { key: haReadingHandle('sensor.kitchen'), label: 'Kitchen', value: '19.4', unit: 'C', mode: 'label_value', stale: false, tone: null },
        { key: PLAYER, label: 'Kitchen speaker', value: tone === 'active' ? 'Playing' : 'Paused', mode: 'label_value', stale: false, tone, media, picture: `${'ab'.repeat(32)}.jpg` },
      ],
      note: null,
    },
  };
}

function frame(type: string, config: Record<string, unknown>, panels: Record<string, unknown>): string {
  const manifest = manifestOf(panels);
  return bitString(
    renderFreeformEpaper(buildEpaperModel(manifest), manifest, [{ type, x: 0, y: 0, w: 1, h: 1, z: 0, config }], { width: W, height: H }),
    W,
    H,
  );
}

const CARD = { variant: 'media' };

describe('the now-playing card on a panel', () => {
  const song = { title: 'Here Comes the Sun', artist: 'The Beatles', duration: 185, startedAt: Date.UTC(2026, 9, 12, 15, 28) };

  it('draws what plays, and a new song is a new frame', () => {
    const playing = frame('homeassistant', CARD, house(song));
    expect(playing).toContain('1');
    expect(frame('homeassistant', CARD, house({ ...song, title: 'Something' }))).not.toBe(playing);
    // Not the list: the card is its own frame.
    expect(frame('homeassistant', {}, house(song))).not.toBe(playing);
  });

  it('is the same frame for as long as the song plays, and never asks where it has got to', () => {
    const playing = frame('homeassistant', CARD, house(song));
    expect(frame('homeassistant', CARD, house({ ...song, startedAt: song.startedAt - 60_000 }))).toBe(playing);
    const input = JSON.stringify(panelInput('homeassistant', manifestOf(house(song)), CARD));
    expect(input).toContain('Here Comes the Sun');
    expect(input).not.toContain('startedAt');
    expect(input).not.toContain('picture');
  });

  it('fills the disc while it plays and rings it while paused', () => {
    expect(frame('homeassistant', CARD, house(song, null))).not.toBe(frame('homeassistant', CARD, house(song)));
  });

  it('says so where the widget shows no player', () => {
    const none = { home: { readings: [{ key: haReadingHandle('sensor.kitchen'), label: 'Kitchen', value: '19.4', mode: 'label_value' }], note: null } };
    expect(frame('homeassistant', CARD, none)).not.toBe(frame('homeassistant', {}, none));
  });
});

describe('the Notifications widget on a panel', () => {
  const panels = {
    notifications: {
      tiles: [{ key: 'tile:aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Freezer left open', detail: 'Freezer door · Open', tone: 'alert', dismissible: true }],
      ha: [{ key: 'han:bbbbbbbbbbbbbbbbbbbbbbbb', title: 'Backup', message: 'The nightly backup failed.' }],
    },
  };

  it('draws the tile and Home Assistant’s, and the second only while the widget shows them', () => {
    const both = frame('notifications', {}, panels);
    const tilesOnly = frame('notifications', { haNotifications: false }, panels);
    expect(both).not.toBe(tilesOnly);
    expect(tilesOnly).toBe(frame('notifications', {}, { notifications: { tiles: panels.notifications.tiles } }));
    expect(frame('notifications', { count: 1 }, panels)).toBe(tilesOnly);
  });

  it('marks an alert, and says so when there is nothing', () => {
    const quiet = { notifications: { tiles: [{ ...panels.notifications.tiles[0], tone: undefined }] } };
    expect(frame('notifications', {}, quiet)).not.toBe(frame('notifications', {}, { notifications: { tiles: panels.notifications.tiles } }));
    expect(frame('notifications', {}, {})).toContain('1');
  });
});
