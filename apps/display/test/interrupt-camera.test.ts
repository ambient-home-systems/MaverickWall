import { describe, expect, it } from 'vitest';
import { interruptsFrom } from '../src/viewmodel.js';

/**
 * A takeover that shows a camera, and comes down at its own time (plan item
 * M6.3), as the wall reads it off the manifest.
 */
const HANDLE = 'A'.repeat(43);
const NOW = 1_800_000_000_000;

const takeover = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ruleId: 'door',
  key: 'event.front_door_ring',
  action: 'takeover',
  title: 'Front door',
  severity: 'Unknown',
  dismissible: true,
  camera: HANDLE,
  until: NOW + 30_000,
  ...over,
});

describe('a held takeover with a camera', () => {
  it('carries the camera and the moment it comes down', () => {
    const [one] = interruptsFrom([takeover()], NOW);
    expect(one).toMatchObject({ takeover: true, camera: HANDLE, until: NOW + 30_000 });
  });

  it('is gone at its own moment by the wall’s clock, with no poll needed', () => {
    expect(interruptsFrom([takeover()], NOW + 29_999)).toHaveLength(1);
    expect(interruptsFrom([takeover()], NOW + 30_000)).toEqual([]);
  });

  it('draws a camera only on a takeover, and only a handle in the shape one has', () => {
    expect(interruptsFrom([takeover({ action: 'banner' })], NOW)[0]).not.toHaveProperty('camera');
    for (const camera of ['camera.front_door', '../../d/manifest', 42, '']) {
      expect(interruptsFrom([takeover({ camera })], NOW)[0]).not.toHaveProperty('camera');
    }
  });

  it('leaves an interrupt with neither exactly as it was', () => {
    const [one] = interruptsFrom([takeover({ camera: undefined, until: undefined })], NOW);
    expect(one).not.toHaveProperty('camera');
    expect(one).not.toHaveProperty('until');
  });
});
