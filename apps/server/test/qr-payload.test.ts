import { describe, expect, it } from 'vitest';

import { encodeQr } from '../src/http/qr.js';
import {
  QR_MAX_BYTES,
  escapeWifi,
  qrBytes,
  qrCaption,
  qrKind,
  qrPasswordLine,
  qrPayload,
  wifiSecurity,
} from '../src/api/qr-payload.js';
import { QR_TOO_LONG, WPA_TOO_SHORT, widgetConfigBody, whenEmptyConfigBody } from '../src/api/widget-schema.js';
import { decodeMatrix } from './qr-decode.js';

/**
 * What a QR code widget encodes, and what the schema refuses (plan item M5.3).
 *
 * Every payload is also read back by an independent decoder, because a string
 * that is right and a code that says it are two different claims — the
 * encoder once drew codes that were correct at every check a person could make
 * and that no phone could read.
 */

/** A Wi-Fi payload read back the way a phone reads one: fields split on unescaped `;`. */
function readWifi(payload: string): Record<string, string> {
  expect(payload.startsWith('WIFI:')).toBe(true);
  const fields: Record<string, string> = {};
  let key = '';
  let value = '';
  let inValue = false;
  for (let index = 'WIFI:'.length; index < payload.length; index++) {
    const character = payload[index] as string;
    if (character === '\\') {
      value += payload[++index] ?? '';
    } else if (!inValue && character === ':') {
      inValue = true;
    } else if (character === ';') {
      if (key !== '') fields[key] = value;
      key = '';
      value = '';
      inValue = false;
    } else if (inValue) {
      value += character;
    } else {
      key += character;
    }
  }
  return fields;
}

const scanned = (config: Record<string, unknown>): string | undefined => {
  const payload = qrPayload(config);
  if (payload === undefined) return undefined;
  const matrix = encodeQr(payload);
  return matrix === undefined ? undefined : decodeMatrix(matrix);
};

describe('a guest Wi-Fi code', () => {
  it('is the WIFI: format a phone joins from, read back by a decoder', () => {
    const config = { ssid: 'Guests', wifiPassword: 'welcome-in' };
    expect(qrPayload(config)).toBe('WIFI:T:WPA;S:Guests;P:welcome-in;;');
    expect(scanned(config)).toBe('WIFI:T:WPA;S:Guests;P:welcome-in;;');
  });

  it('escapes the five reserved characters, so a name or a password survives the round trip', () => {
    const ssid = 'Home;Net, "2":\\';
    const password = 'p;a,s:s"w\\ord';
    expect(escapeWifi(ssid)).toBe('Home\\;Net\\, \\"2\\"\\:\\\\');
    const fields = readWifi(scanned({ ssid, wifiPassword: password }) as string);
    expect(fields).toEqual({ T: 'WPA', S: ssid, P: password });
  });

  it('carries WEP, an open network with no password field, and a hidden network', () => {
    expect(readWifi(qrPayload({ ssid: 'Old', wifiPassword: 'abcde', wifiSecurity: 'WEP' }) as string)).toEqual({
      T: 'WEP',
      S: 'Old',
      P: 'abcde',
    });
    // An open network's password is not sent, even if one was typed earlier.
    expect(qrPayload({ ssid: 'Cafe', wifiPassword: 'left-over', wifiSecurity: 'nopass' })).toBe('WIFI:T:nopass;S:Cafe;;');
    expect(readWifi(qrPayload({ ssid: 'Quiet', wifiPassword: 'welcome-in', wifiHidden: true }) as string)).toEqual({
      T: 'WPA',
      S: 'Quiet',
      P: 'welcome-in',
      H: 'true',
    });
  });

  it('is nothing to encode until it has a name, and a password unless it is open', () => {
    expect(qrPayload({})).toBeUndefined();
    expect(qrPayload({ wifiPassword: 'welcome-in' })).toBeUndefined();
    // A secured network with no password would be a code that offers to join
    // a network which then refuses — so it is no code at all.
    expect(qrPayload({ ssid: 'Guests' })).toBeUndefined();
    expect(qrPayload({ ssid: 'Guests', wifiPassword: '' })).toBeUndefined();
    expect(qrPayload({ ssid: 'Guests', wifiSecurity: 'nopass' })).toBe('WIFI:T:nopass;S:Guests;;');
  });

  it('writes the name under the code, and the password only when asked and only when there is one', () => {
    expect(qrCaption({ ssid: 'Guests' })).toBe('Guests');
    expect(qrPasswordLine({ ssid: 'Guests', wifiPassword: 'welcome-in' })).toBeUndefined();
    expect(qrPasswordLine({ ssid: 'Guests', wifiPassword: 'welcome-in', showPassword: true })).toBe('welcome-in');
    expect(qrPasswordLine({ ssid: 'Cafe', wifiPassword: 'x', wifiSecurity: 'nopass', showPassword: true })).toBeUndefined();
    expect(qrPasswordLine({ mode: 'link', wifiPassword: 'welcome-in', showPassword: true })).toBeUndefined();
  });
});

describe('a link and some words', () => {
  it('encodes a link as it was written, and names it under the code without its scheme', () => {
    const config = { mode: 'link', link: 'https://example.com/menu/' };
    expect(qrKind(config)).toBe('link');
    expect(scanned(config)).toBe('https://example.com/menu/');
    expect(qrCaption(config)).toBe('example.com/menu');
  });

  it('encodes words as they were typed, accents and all, with no caption of their own', () => {
    const config = { mode: 'text', text: 'Café — door code 4821' };
    expect(scanned(config)).toBe('Café — door code 4821');
    expect(qrCaption(config)).toBeUndefined();
  });

  it('reads an unknown or absent kind as Wi-Fi, and an unknown security as WPA', () => {
    expect(qrKind({ mode: 'month' })).toBe('wifi');
    expect(qrKind(undefined)).toBe('wifi');
    expect(wifiSecurity({ wifiSecurity: 'WPA3' })).toBe('WPA');
  });
});

describe('the schema', () => {
  const ok = (config: Record<string, unknown>) => widgetConfigBody.safeParse(config);
  const messages = (config: Record<string, unknown>) => {
    const result = ok(config);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('stores every key a code is made from', () => {
    expect(
      ok({
        ssid: 'Guests',
        wifiPassword: 'welcome-in',
        wifiSecurity: 'WEP',
        wifiHidden: true,
        showPassword: true,
        mode: 'link',
        link: 'http://192.168.1.4/menu',
        text: 'Hello',
      }).success,
    ).toBe(true);
  });

  it('refuses a link that is not http or https, rather than encoding it', () => {
    expect(ok({ mode: 'link', link: 'javascript:alert(1)' }).success).toBe(false);
    expect(ok({ mode: 'link', link: 'example.com' }).success).toBe(false);
    expect(ok({ mode: 'link', link: 'https://example.com/a b' }).success).toBe(false);
  });

  it('refuses a code too long for one QR code, with a sentence, on the field that made it so', () => {
    const words = 'x'.repeat(QR_MAX_BYTES + 1);
    expect(messages({ mode: 'text', text: words })).toEqual([`text: ${QR_TOO_LONG}`]);
    expect(ok({ mode: 'text', text: 'x'.repeat(QR_MAX_BYTES) }).success).toBe(true);
    // Counted in bytes, the encoder's unit: 107 accented letters are 214.
    expect(qrBytes('é'.repeat(107))).toBe(214);
    expect(messages({ mode: 'text', text: 'é'.repeat(107) })).toEqual([`text: ${QR_TOO_LONG}`]);
    // And the same rule holds for a fallback, which is a widget too.
    expect(whenEmptyConfigBody.safeParse({ mode: 'text', text: words }).success).toBe(false);
  });

  it('holds the longest network a household can type to one code: refused just past it, read back just inside', () => {
    // Thirty-two reserved characters and sixty-three in the password, each
    // escaped, is 215 bytes: two past what one code holds, so it is refused.
    const worst = { ssid: ';'.repeat(32), wifiPassword: '\\'.repeat(63), wifiHidden: true };
    expect(qrBytes(qrPayload(worst) as string)).toBe(215);
    expect(messages(worst)).toEqual([`wifiPassword: ${QR_TOO_LONG}`]);
    // One character fewer in each is 211, and it fits and reads back whole.
    const fits = { ssid: ';'.repeat(31), wifiPassword: '\\'.repeat(62), wifiHidden: true };
    expect(ok(fits).success).toBe(true);
    expect(readWifi(scanned(fits) as string)).toEqual({ T: 'WPA', S: ';'.repeat(31), P: '\\'.repeat(62), H: 'true' });
  });

  it('refuses a WPA password no network could have, and leaves WEP and open networks alone', () => {
    expect(messages({ ssid: 'Guests', wifiPassword: 'short' })).toEqual([`wifiPassword: ${WPA_TOO_SHORT}`]);
    expect(ok({ ssid: 'Guests', wifiPassword: 'abcde', wifiSecurity: 'WEP' }).success).toBe(true);
    expect(ok({ ssid: 'Guests', wifiPassword: 'short', wifiSecurity: 'nopass' }).success).toBe(true);
    // A link widget that once held a short password is a link, not a network.
    expect(ok({ mode: 'link', link: 'https://example.com', wifiPassword: 'short' }).success).toBe(true);
  });

  it('refuses a name or a password longer than Wi-Fi allows', () => {
    expect(ok({ ssid: 'x'.repeat(33) }).success).toBe(false);
    expect(ok({ ssid: 'Guests', wifiPassword: 'x'.repeat(64) }).success).toBe(false);
    expect(ok({ wifiSecurity: 'WPA3' }).success).toBe(false);
  });
});
