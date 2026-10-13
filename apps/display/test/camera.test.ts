import { describe, expect, it } from 'vitest';

import {
  CAMERA_BOUNDARY,
  cameraIsLive,
  createPartReader,
  cameraContains,
  cameraHandleOf,
  cameraNote,
  camerasFrom,
  cameraWanted,
  pictureIsStale,
  refreshSeconds,
  retryDelayMs,
} from '../src/camera.js';

/**
 * A camera widget's decisions, without a page (plan item M6.1): which camera a
 * box names, whether it is asked for at all, how often, and what the box says
 * while there is no picture to show.
 */

const HANDLE = 'A'.repeat(43);

describe('the cameras panel', () => {
  it('reads handles and whether each is there, and drops anything else', () => {
    expect(
      camerasFrom({
        cameras: [
          { handle: HANDLE, available: true },
          { handle: 'B'.repeat(43), available: false },
          { handle: 'camera.front_door', available: true },
          'nonsense',
          { available: true },
        ],
      }),
    ).toEqual([
      { handle: HANDLE, available: true },
      { handle: 'B'.repeat(43), available: false },
    ]);
    expect(camerasFrom(undefined)).toEqual([]);
    expect(camerasFrom({ cameras: 'no' })).toEqual([]);
  });
});

describe('a camera box', () => {
  const cameras = [{ handle: HANDLE, available: true }, { handle: 'B'.repeat(43), available: false }];

  it('names a camera by handle alone', () => {
    expect(cameraHandleOf({ camera: HANDLE })).toBe(HANDLE);
    expect(cameraHandleOf({ camera: 'camera.front_door' })).toBeUndefined();
    expect(cameraHandleOf({})).toBeUndefined();
  });

  it('asks for a picture only of a camera the manifest lists as there', () => {
    expect(cameraWanted(cameras, HANDLE)).toBe(true);
    expect(cameraWanted(cameras, 'B'.repeat(43))).toBe(false);
    expect(cameraWanted(cameras, 'C'.repeat(43))).toBe(false);
    expect(cameraWanted(cameras, undefined)).toBe(false);
  });

  it('says something true in every state, and nothing once the picture is up', () => {
    expect(cameraNote(cameras, undefined, undefined)).toBe('Choose a camera in this widget’s options.');
    expect(cameraNote(cameras, 'B'.repeat(43), 'live')).toBe('This camera is not answering at the moment.');
    expect(cameraNote(cameras, HANDLE, undefined)).toBe('Waiting for the first picture.');
    expect(cameraNote(cameras, HANDLE, 'failed')).toBe('No picture from this camera just now.');
    expect(cameraNote(cameras, HANDLE, 'live')).toBe('');
    // The editor's preview fetches nothing, so it says where the picture goes.
    expect(cameraNote(cameras, HANDLE, undefined, false)).toBe('The camera’s picture is shown here on the wall.');
  });

  it('refreshes every three seconds unless told, inside one second to a minute', () => {
    expect(refreshSeconds({})).toBe(3);
    expect(refreshSeconds({ cameraRefreshSec: 10 })).toBe(10);
    expect(refreshSeconds({ cameraRefreshSec: 0 })).toBe(3);
    expect(refreshSeconds({ cameraRefreshSec: 61 })).toBe(3);
    expect(refreshSeconds({ cameraRefreshSec: 2.5 })).toBe(3);
  });

  it('fills its box unless told to show the whole picture', () => {
    expect(cameraContains({})).toBe(false);
    expect(cameraContains({ fit: 'contain' })).toBe(true);
  });

  it('retries a failed picture after five seconds, doubling to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('calls a picture old after three refreshes missed, and not before', () => {
    expect(pictureIsStale(undefined, 100_000, 3)).toBe(false);
    expect(pictureIsStale(100_000, 109_000, 3)).toBe(false);
    expect(pictureIsStale(100_000, 109_001, 3)).toBe(true);
  });
});

describe('the live stream', () => {
  const bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const part = (body: Uint8Array, length = body.length): Uint8Array => {
    const head = bytes(`--${CAMERA_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`);
    const out = new Uint8Array(head.length + body.length + 2);
    out.set(head);
    out.set(body, head.length);
    out.set(bytes('\r\n'), head.length + body.length);
    return out;
  };
  const frameA = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
  const frameB = Uint8Array.from({ length: 180 }, (_, i) => (i * 13 + 1) % 256);
  const whole = (() => {
    const a = part(frameA);
    const b = part(frameB);
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  })();

  it('is asked for only when the widget says live', () => {
    expect(cameraIsLive({ cameraMode: 'stream' })).toBe(true);
    expect(cameraIsLive({})).toBe(false);
    expect(cameraIsLive({ cameraMode: 'snapshot' })).toBe(false);
  });

  it('reads the server’s frames by their lengths, split at every byte', () => {
    for (let cut = 0; cut <= whole.length; cut++) {
      const reader = createPartReader();
      const got = [...reader.push(whole.subarray(0, cut)), ...reader.push(whole.subarray(cut))];
      expect(got.map((frame) => Array.from(frame))).toEqual([Array.from(frameA), Array.from(frameB)]);
    }
  });

  it('skips a part whose length cannot be read, or is over the cap, and reads on', () => {
    const reader = createPartReader(250);
    const bad = bytes(`--${CAMERA_BOUNDARY}\r\nContent-Length: lots\r\n\r\nxx`);
    const got = [...reader.push(bad), ...reader.push(part(frameA)), ...reader.push(part(frameB))];
    // A is over 250 bytes and is passed over; B is read.
    expect(got.map((frame) => frame.length)).toEqual([180]);
  });
});
