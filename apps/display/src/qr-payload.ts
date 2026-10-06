/**
 * What a QR code widget encodes, transcribed from the server's
 * `api/qr-payload.ts` (plan item M5.3), which says why there are two copies
 * and why the password travels. `transcription-parity.test.ts` holds them to each other.
 */

/* qr-payload:begin */
export type QrKind = 'wifi' | 'link' | 'text';
export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';

/**
 * The most bytes a code the encoder draws can hold: byte mode, level M,
 * version 10. Past it `encodeQr` refuses rather than guesses, and the schema
 * refuses the config first, with a sentence.
 */
export const QR_MAX_BYTES = 213;

function field(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Which kind of code: absent and anything unknown is guest Wi-Fi. */
export function qrKind(config: unknown): QrKind {
  const mode = field(config, 'mode');
  return mode === 'link' ? 'link' : mode === 'text' ? 'text' : 'wifi';
}

/** The network's security: absent is WPA, which is what nearly every network is. */
export function wifiSecurity(config: unknown): WifiSecurity {
  const security = field(config, 'wifiSecurity');
  return security === 'WEP' ? 'WEP' : security === 'nopass' ? 'nopass' : 'WPA';
}

/**
 * The five characters the Wi-Fi format reserves, each with a backslash before
 * it. A network called `Home;Net` written unescaped is a code whose name ends
 * at the semicolon, which a phone joins nothing with.
 */
export function escapeWifi(value: string): string {
  return value.replace(/[\\;,:"]/g, (character) => '\\' + character);
}

/**
 * The text the code carries, or undefined while there is nothing to encode yet.
 *
 * A secured network with no password yet is nothing to encode rather than a
 * code for an open network: a phone would offer to join a network that then
 * refuses it, which reads as the wall being wrong.
 */
export function qrPayload(config: unknown): string | undefined {
  const kind = qrKind(config);
  if (kind === 'link') return field(config, 'link');
  if (kind === 'text') return field(config, 'text');
  const ssid = field(config, 'ssid');
  if (ssid === undefined) return undefined;
  const security = wifiSecurity(config);
  const password = field(config, 'wifiPassword');
  if (security !== 'nopass' && password === undefined) return undefined;
  const hidden = typeof config === 'object' && config !== null && (config as Record<string, unknown>)['wifiHidden'] === true;
  return (
    'WIFI:T:' + security + ';S:' + escapeWifi(ssid) + ';' +
    (security === 'nopass' ? '' : 'P:' + escapeWifi(password as string) + ';') +
    (hidden ? 'H:true;' : '') +
    ';'
  );
}

/** How many bytes a payload is, which is what the encoder counts. */
export function qrBytes(payload: string): number {
  return new TextEncoder().encode(payload).length;
}

/**
 * The words under the code: the network's name, or the link as somebody would
 * type it. Text has none of its own — the box's title is where it is named.
 */
export function qrCaption(config: unknown): string | undefined {
  const kind = qrKind(config);
  if (kind === 'wifi') return field(config, 'ssid');
  if (kind === 'text') return undefined;
  const link = field(config, 'link');
  return link === undefined ? undefined : link.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** The password written out, when the household asked for it and there is one. */
export function qrPasswordLine(config: unknown): string | undefined {
  if (qrKind(config) !== 'wifi' || wifiSecurity(config) === 'nopass') return undefined;
  if (typeof config !== 'object' || config === null) return undefined;
  if ((config as Record<string, unknown>)['showPassword'] !== true) return undefined;
  return field(config, 'wifiPassword');
}
/* qr-payload:end */
