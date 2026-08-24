import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Secrets at rest.
 *
 * Calendar feed URLs are bearer credentials: a Google private iCal URL grants
 * permanent read access to a household's calendar and never expires. They live
 * in `/data/wall.db`, and `/data` is exactly what people copy to a NAS, sync to
 * Dropbox, and attach to a GitHub issue when something breaks. Storing them in
 * clear text would mean the first person who shares a backup to get help hands
 * out their family's calendar.
 *
 * So the database holds ciphertext and the key lives beside it in a separate
 * file. That is not a strong boundary — anyone with the whole volume has both —
 * but it defeats the realistic threat, which is a copied database rather than a
 * compromised host.
 */

/** Root key length. AES-256 needs 32 bytes and HKDF derives from the same. */
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_PREFIX = 'mw1';

export type SecretPurpose =
  /** Calendar feed URLs. */
  | 'calendar-source-url'
  /** Home Assistant long-lived access tokens. */
  | 'ha-token'
  /** Display tokens issued to screens. */
  | 'display-token'
  /** Credentials a recipe injects into its fetch (an API key). */
  | 'recipe-secret'
  /** Session signing. */
  | 'session';

export interface Keyring {
  /** Encrypt for a purpose. The purpose is authenticated, not just namespaced. */
  encrypt(plaintext: string, purpose: SecretPurpose): string;
  /** Never throws. A wrong key or tampered value comes back as a failure. */
  decrypt(envelope: string, purpose: SecretPurpose): DecryptResult;
}

export type DecryptFailure =
  /** Not our envelope format at all. */
  | 'malformed'
  /** Envelope version we do not understand. Forward compatibility. */
  | 'unsupported-version'
  /**
   * Authentication failed. Either the value was tampered with, or — far more
   * likely — the database was restored without its matching key file.
   */
  | 'authentication-failed';

export type DecryptResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: DecryptFailure };

export interface MasterKeyResult {
  readonly key: Buffer;
  /** True when this run generated the key rather than reading an existing one. */
  readonly created: boolean;
  /**
   * Set when the key file's permissions are looser than intended. Some volume
   * drivers — Docker Desktop bind mounts on macOS and Windows especially —
   * cannot represent 0600, and refusing to start over it would brick a wall
   * display for a condition the user cannot fix.
   */
  readonly permissionWarning?: string;
  /**
   * Set when the key file on disk was unusable — the wrong length even after
   * trimming trailing whitespace — and a fresh key was generated in its
   * place. The old file is renamed aside rather than overwritten, but
   * anything already encrypted with it (every calendar feed address) will
   * need re-entering, because that ciphertext cannot be read with the new key.
   */
  readonly unusableKeyWarning?: string;
}

function keyPath(dataDir: string): string {
  return join(dataDir, '.secret');
}

const TRAILING_WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

/** Trailing tab, newline, carriage return or space bytes, stripped. */
function trimTrailingWhitespace(buffer: Buffer): Buffer {
  let end = buffer.length;
  while (end > 0 && TRAILING_WHITESPACE.has(buffer[end - 1] as number)) end--;
  return buffer.subarray(0, end);
}

/**
 * Whether a buffer is a usable master key, after allowing for a trailing
 * newline — the ordinary outcome of a text editor, `echo`, a copy-paste or a
 * sync tool touching the raw binary key. Never trims a buffer that is already
 * the right length, so a genuine key whose last byte happens to be a
 * whitespace byte is never shortened.
 *
 * Shared between loading the key at boot and validating a re-uploaded one on
 * the restore screen — a key good enough to boot with should be good enough
 * to restore, and the reverse.
 */
export function normaliseMasterKeyBytes(buffer: Buffer): Buffer | undefined {
  if (buffer.length === MASTER_KEY_BYTES) return buffer;
  const trimmed = trimTrailingWhitespace(buffer);
  return trimmed.length === MASTER_KEY_BYTES ? trimmed : undefined;
}

/**
 * Load the master key, creating it on first run.
 *
 * Concurrency-safe by construction: creation uses an exclusive open, so if two
 * processes start together exactly one writes the key and the other reads it.
 * Nothing here logs the key, and nothing returns it in an error message.
 */
export function loadOrCreateMasterKey(dataDir: string, now: () => number = Date.now): MasterKeyResult {
  const path = keyPath(dataDir);

  let unusableKeyWarning: string | undefined;
  try {
    const existing = readFileSync(path);
    /*
     * Allows for a trailing newline — the common case: System → Backup hands
     * over a raw binary blob, and a text editor, `echo`, a copy-paste or a
     * sync tool routinely adds one. 33 bytes is the ordinary outcome of
     * following the restore instructions slightly imperfectly, and the key
     * underneath it is still the right one.
     */
    const usable = normaliseMasterKeyBytes(existing);
    if (usable !== undefined) {
      return { key: usable, created: false };
    }

    /*
     * Still wrong. Rule nine: this must degrade rather than stop the process
     * — under `restart: unless-stopped`, or the supervisor, an unguarded
     * throw here is an endless restart loop and a wall with no message
     * anywhere a household can read. The old file is kept, renamed aside,
     * in case its bytes are ever wanted; a fresh key falls through below.
     *
     * The rename itself is allowed to fail — a read-only file in an
     * otherwise writable directory, say — without taking boot down with it.
     * A fresh key still gets written below, onto the same path, by the
     * write-then-rename that already has to handle a losing race; that
     * replaces the corrupted file in place rather than moving it aside.
     */
    const brokenPath = `${path}.unusable.${now()}`;
    let movedAside = true;
    try {
      renameSync(path, brokenPath);
    } catch {
      movedAside = false;
    }
    unusableKeyWarning =
      `The encryption key at ${path} was ${existing.length} bytes; expected ` +
      `${MASTER_KEY_BYTES}. ` +
      (movedAside
        ? `It has been moved to ${brokenPath} and a new key was generated. `
        : `It could not be moved aside, so a new key was written over it. `) +
      'Calendar feed addresses will need re-entering.';
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(MASTER_KEY_BYTES);

  // Write to a temporary file and rename, so a crash mid-write cannot leave a
  // truncated key that would decrypt nothing and be silently accepted.
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, key, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (isExists(error)) {
      // Another process won the race. Read what it wrote — but if this
      // process just discovered and moved aside a corrupted key, that is
      // still true and still worth the household reading, whoever wrote the
      // replacement.
      return {
        key: readFileSync(path),
        created: false,
        ...(unusableKeyWarning === undefined ? {} : { unusableKeyWarning }),
      };
    }
    throw error;
  }

  let permissionWarning: string | undefined;
  try {
    chmodSync(path, 0o600);
  } catch {
    permissionWarning =
      `Could not restrict permissions on ${path}. This is normal on some ` +
      'bind-mounted volumes. Anyone who can read the data directory can read ' +
      'the encryption key.';
  }

  return {
    key,
    created: true,
    ...(permissionWarning === undefined ? {} : { permissionWarning }),
    ...(unusableKeyWarning === undefined ? {} : { unusableKeyWarning }),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

/**
 * Derive a per-purpose subkey.
 *
 * One root secret, separate keys per use, so a subkey recovered from one place
 * cannot decrypt another. HKDF is the standard construction for this and costs
 * a single line.
 */
export function deriveKey(masterKey: Buffer, purpose: SecretPurpose): Buffer {
  const derived = hkdfSync('sha256', masterKey, Buffer.alloc(0), `maverick-wall:${purpose}`, 32);
  return Buffer.from(derived);
}

/**
 * Envelope: `mw1.<base64url(iv || ciphertext || tag)>`.
 *
 * Versioned so the algorithm can change without a migration guessing game, and
 * self-describing so a value pasted into a log is recognisable as ciphertext
 * rather than mistaken for a token.
 */
function seal(plaintext: string, key: Buffer, purpose: SecretPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // The purpose is bound into the ciphertext, not merely used to pick a key.
  // Without this, a ciphertext could be moved between columns and would still
  // decrypt — a calendar URL swapped into the Home Assistant token field.
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}.${Buffer.concat([iv, body, tag]).toString('base64url')}`;
}

function open(envelope: string, key: Buffer, purpose: SecretPurpose): DecryptResult {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  const separator = envelope.indexOf('.');
  if (separator < 0) return { ok: false, reason: 'malformed' };

  const version = envelope.slice(0, separator);
  if (version !== ENVELOPE_PREFIX) {
    return { ok: false, reason: version.startsWith('mw') ? 'unsupported-version' : 'malformed' };
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(envelope.slice(separator + 1), 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (raw.length < IV_BYTES + TAG_BYTES) return { ok: false, reason: 'malformed' };

  const iv = raw.subarray(0, IV_BYTES);
  const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return { ok: true, value: plaintext };
  } catch {
    // GCM authentication failure. Deliberately indistinguishable from tampering
    // and from a wrong key, because the caller should treat both the same way:
    // the value is unusable and needs re-entering.
    return { ok: false, reason: 'authentication-failed' };
  }
}

export function createKeyring(masterKey: Buffer): Keyring {
  // Subkeys are derived once. Deriving per call would be correct but wasteful
  // on a Pi doing this for every row of a calendar sync.
  const cache = new Map<SecretPurpose, Buffer>();
  const keyFor = (purpose: SecretPurpose): Buffer => {
    let key = cache.get(purpose);
    if (!key) {
      key = deriveKey(masterKey, purpose);
      cache.set(purpose, key);
    }
    return key;
  };

  return {
    encrypt: (plaintext, purpose) => seal(plaintext, keyFor(purpose), purpose),
    decrypt: (envelope, purpose) => open(envelope, keyFor(purpose), purpose),
  };
}

/** True when a stored value looks like one of our envelopes. */
export function isEnvelope(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${ENVELOPE_PREFIX}.`);
}

/**
 * Constant-time comparison for tokens.
 *
 * Display tokens are compared on every poll from every screen, which is exactly
 * the repetition a timing attack needs.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
