import { describe, expect, it } from 'vitest';

import { qrWordsKept } from '../src/widget-tiers.js';
import { encodeQr } from '../src/qr.js';
import { qrPayload } from '../src/qr-payload.js';

/**
 * A QR code's words under it, given up from the box (plan item M5.3).
 *
 * The code is what the widget is for, so the network's name and the password
 * keep their lines only while the square they leave the code is at least half
 * the box's shorter side — asked of the box's proportion, so one rule holds on
 * a phone-sized preview and a television.
 */
describe('qrWordsKept', () => {
  it('keeps every line in a tall box, where the words cost the code nothing', () => {
    expect(qrWordsKept(400, 800, [40, 30])).toBe(2);
  });

  it('gives up the last line first in a wide, short one, and keeps the name while it can', () => {
    // 200 tall: a 40px name leaves 160, a 30px password after it leaves 130 — both at least 100.
    expect(qrWordsKept(900, 200, [40, 30])).toBe(2);
    // 130 tall: the name leaves 90, over the half of 65; the password after it would leave 60.
    expect(qrWordsKept(900, 130, [40, 30])).toBe(1);
    // 70 tall: even the name would leave 30, under the half of 35.
    expect(qrWordsKept(900, 70, [40, 30])).toBe(0);
  });

  it('is the same answer at any scale, because it asks the box’s proportion', () => {
    for (const scale of [0.5, 1, 3]) {
      expect(qrWordsKept(900 * scale, 130 * scale, [40 * scale, 30 * scale])).toBe(1);
    }
  });

  it('has nothing to give up when there are no words', () => {
    expect(qrWordsKept(100, 10, [])).toBe(0);
  });
});

describe('the bundle’s encoder', () => {
  it('encodes what the payload builder says, at the version the payload needs', () => {
    const payload = qrPayload({ ssid: 'Guests', wifiPassword: 'welcome-in' }) as string;
    const matrix = encodeQr(payload);
    expect(matrix?.size).toBe(matrix === undefined ? 0 : matrix.version * 4 + 17);
    expect(encodeQr('x'.repeat(214))).toBeUndefined();
  });
});
