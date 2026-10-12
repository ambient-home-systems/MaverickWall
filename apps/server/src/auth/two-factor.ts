import { createHmac } from 'node:crypto';

/**
 * Two-step sign-in's recovery codes, kept as hashes (plan item M8.2).
 *
 * Better Auth's two-factor plugin stores its backup codes *encrypted* by
 * default — symmetric under the session secret, so anybody holding the
 * database and the key reads every unused code back. A recovery code is a
 * password by another name, and a password is kept as a hash. The plugin
 * takes an `{ encrypt, decrypt }` pair for its store, and this is one where
 * "encrypt" is a keyed hash of each code and "decrypt" is the identity: the
 * column holds hashes, and the plugin compares hashes.
 *
 * That works because the plugin compares `codes.includes(code)` against
 * whatever `decrypt` hands back, so the code it is given has to be a hash too.
 * It is: the only door a recovery code comes in by is the sign-in page's own
 * handler, which hashes what was typed before asking the plugin
 * (`recoveryCodeHash`), and the plugin's HTTP route for it is refused from
 * outside (`app.ts`), so a typed code never reaches the comparison raw.
 *
 * `encrypt` is idempotent on purpose. The plugin re-encodes the *remaining*
 * list after a code is used, and that list is already hashes; hashing them
 * again would leave none that match. A hash is 64 hex characters behind a
 * prefix no generated code can start with (codes are `xxxxx-xxxxx`), so one
 * is never mistaken for the other.
 */

const PREFIX = 'h:';
const HASHED = /^h:[0-9a-f]{64}$/;

/** A typed recovery code, as the column keeps it. Trimmed; codes are case-sensitive. */
export function recoveryCodeHash(secret: string, code: string): string {
  return `${PREFIX}${createHmac('sha256', `recovery-code:${secret}`).update(code.trim()).digest('hex')}`;
}

export function recoveryCodeStore(secret: string): {
  encrypt: (json: string) => Promise<string>;
  decrypt: (stored: string) => Promise<string>;
} {
  return {
    encrypt: async (json: string): Promise<string> => {
      const parsed: unknown = JSON.parse(json);
      const codes = Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === 'string') : [];
      return JSON.stringify(codes.map((code) => (HASHED.test(code) ? code : recoveryCodeHash(secret, code))));
    },
    decrypt: async (stored: string): Promise<string> => stored,
  };
}

/** The issuer a code app shows beside the account: what the household calls the thing. */
export const TOTP_ISSUER = 'Maverick Wall';

/** How many recovery codes a household is given. The plugin's own default. */
export const RECOVERY_CODE_COUNT = 10;
