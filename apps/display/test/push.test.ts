import { describe, expect, it } from 'vitest';

import { PUSH_RETRY_MAX_MS, isNudge, pushUrl, retryDelay, startPush, type SocketLike } from '../src/push.js';

/**
 * The wall's end of the push channel (plan item M1.1): what it treats as a
 * reason to poll, where it connects, and how it keeps trying — against a fake
 * socket and a fake clock, so every retry can be counted.
 */

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
}

function rig(): {
  sockets: FakeSocket[];
  timers: { run: () => void; ms: number; cleared: boolean }[];
  nudges: number;
  channel: ReturnType<typeof startPush>;
} {
  const state = {
    sockets: [] as FakeSocket[],
    timers: [] as { run: () => void; ms: number; cleared: boolean }[],
    nudges: 0,
  };
  const channel = startPush({
    url: 'ws://wall.local/d/push',
    onNudge: () => {
      state.nudges += 1;
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      state.sockets.push(socket);
      return socket;
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    random: () => 0,
  });
  return Object.assign(state, { channel });
}

const MANIFEST_CHANGED = JSON.stringify({ type: 'MANIFEST_CHANGED', protocol: 1, sentAt: 1, etag: '"a"' });
const INTERRUPT_PUSH = JSON.stringify({ type: 'INTERRUPT_PUSH', protocol: 1, sentAt: 1, interrupts: [], wakeScreen: false });

describe('pushUrl', () => {
  it('is the page’s own host, and wss under https', () => {
    expect(pushUrl({ protocol: 'http:', host: '192.168.1.10:8080' })).toBe('ws://192.168.1.10:8080/d/push');
    expect(pushUrl({ protocol: 'https:', host: 'wall.example' })).toBe('wss://wall.example/d/push');
  });
});

describe('isNudge', () => {
  it('takes the two messages the server sends, and nothing else', () => {
    expect(isNudge(MANIFEST_CHANGED)).toBe(true);
    expect(isNudge(INTERRUPT_PUSH)).toBe(true);
    expect(isNudge(JSON.stringify({ type: 'MANIFEST_CHANGED', protocol: 2 }))).toBe(false);
    expect(isNudge(JSON.stringify({ type: 'RELOAD', protocol: 1 }))).toBe(false);
    expect(isNudge('not json')).toBe(false);
    expect(isNudge(new ArrayBuffer(4))).toBe(false);
  });
});

describe('retryDelay', () => {
  it('doubles from a second to a minute, half fixed and half random', () => {
    expect(retryDelay(0, () => 0)).toBe(500);
    expect(retryDelay(0, () => 1)).toBe(1000);
    expect(retryDelay(3, () => 0)).toBe(4000);
    expect(retryDelay(20, () => 0)).toBe(PUSH_RETRY_MAX_MS / 2);
    expect(retryDelay(20, () => 1)).toBe(PUSH_RETRY_MAX_MS);
  });
});

describe('startPush', () => {
  it('asks for a poll on every message the server sends, and on nothing else', () => {
    const r = rig();
    expect(r.sockets).toHaveLength(1);
    expect(r.sockets[0]!.url).toBe('ws://wall.local/d/push');
    r.sockets[0]!.onopen?.({});
    r.sockets[0]!.onmessage?.({ data: INTERRUPT_PUSH });
    r.sockets[0]!.onmessage?.({ data: MANIFEST_CHANGED });
    r.sockets[0]!.onmessage?.({ data: '{"type":"HELLO","protocol":1}' });
    expect(r.nudges).toBe(2);
    expect(r.channel.connected()).toBe(true);
  });

  it('tries again when the socket closes, backing off, and starts again from a second once it opens', () => {
    const r = rig();
    r.sockets[0]!.onerror?.({});
    r.sockets[0]!.onclose?.({});
    expect(r.channel.connected()).toBe(false);
    // One retry per close, however many events came before it.
    expect(r.timers.map((timer) => timer.ms)).toEqual([500]);
    r.timers[0]!.run();
    r.sockets[1]!.onclose?.({});
    r.timers[1]!.run();
    r.sockets[2]!.onclose?.({});
    expect(r.timers.map((timer) => timer.ms)).toEqual([500, 1000, 2000]);
    r.timers[2]!.run();
    r.sockets[3]!.onopen?.({});
    r.sockets[3]!.onclose?.({});
    expect(r.timers[3]!.ms).toBe(500);
  });

  it('stops for good: closes the socket, cancels a retry, and never opens another', () => {
    const r = rig();
    r.sockets[0]!.onclose?.({});
    r.channel.stop();
    expect(r.timers[0]!.cleared).toBe(true);
    r.timers[0]!.run();
    expect(r.sockets).toHaveLength(1);

    const s = rig();
    s.sockets[0]!.onopen?.({});
    s.channel.stop();
    expect(s.sockets[0]!.closed).toBe(true);
    s.sockets[0]!.onclose?.({});
    expect(s.timers).toEqual([]);
  });

  it('keeps trying, later, on a browser with no WebSocket at all', () => {
    const timers: number[] = [];
    startPush({
      url: 'ws://wall.local/d/push',
      onNudge: () => {},
      createSocket: () => {
        throw new Error('no WebSocket');
      },
      setTimer: (_run, ms) => {
        timers.push(ms);
        return ms;
      },
      random: () => 0,
    });
    expect(timers).toEqual([500]);
  });
});
