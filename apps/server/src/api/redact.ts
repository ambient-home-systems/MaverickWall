import type { LogLine } from '../logbuffer.js';

/**
 * What the log tail is allowed to carry out of the house.
 *
 * The diagnostics export is offered to a household as "safe to attach to a bug
 * report", and every other field in it is a *projection* somebody chose: a
 * host without its path, a count without the rows, a job kind without its
 * payload. The log was the one field that was not — it was `input.log`,
 * verbatim — so it was an open channel from any `console.log` in the process
 * straight into a file people are told to hand over. It shipped the first-run
 * setup token and the bootstrap short code, because `main.ts` prints both and
 * `log.capture()` is installed before it does.
 *
 * This runs on the way *out*, in `buildDiagnostics`, and deliberately not in
 * `logbuffer.record`. The code printed on stdout is the household's only way
 * into a fresh installation; redacting at the source would brick first-run
 * setup to fix a file nobody has downloaded yet. The terminal keeps the truth
 * and the export does not.
 *
 * The redaction replaces the *value* and keeps the line, because a bug report
 * needs to know a line was there — "Or go to http://192.168.1.10:8080/setup
 * and enter this code:  [redacted]" is a complete account of what happened at
 * boot, and a deleted line is not.
 *
 * The cost is real and is bounded on purpose: over-redacting is the failure
 * mode that matters most here, because an export stripped of identifiers is an
 * export people stop attaching, and then rule eleven — errors have to be
 * self-diagnosable by somebody nobody can reach — is worse off than before.
 * Hostnames, IP addresses, ports, paths, error codes, job kinds, versions and
 * this repository's own ids (eight random bytes as hex, sixteen characters)
 * all survive untouched, and there are assertions for each.
 */

/** Kept short and obviously not a value, so nobody mistakes it for one. */
export const REDACTED = '[redacted]';

/**
 * Header names whose value is a credential in its entirety.
 *
 * These take the rest of the line rather than one token, because a header
 * value is not a single word: `Cookie: a=1; mw_session=…` leaks from the third
 * field, and `Authorization: Bearer …` from the second. The value stops at a
 * double quote so the shape of a shell command survives — `curl -H
 * "Authorization: [redacted]" \` still reads as the instruction it was.
 */
const CREDENTIAL_HEADERS =
  /\b(authorization|proxy-authorization|set-cookie|cookie|x-api-key|x-auth-token)(\s*[:=]\s*)[^"\n]*/gi;

/** An auth scheme and its value, for the case the header name is not in the line. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Labels whose value is a secret wherever one appears.
 *
 * Longest alternative first, so `access_token` is not read as a bare `token`.
 * `code` is in the list for the bootstrap short code, which is eight
 * characters from a 27-symbol alphabet and so is far too short for the entropy
 * rule below to reach. That costs a hypothetical `code: PARSE_FAILED` its
 * value — no such line reaches this buffer today (the one that reads that way
 * is `diagnose-source`, a separate process whose console is never captured),
 * and where it would, the label and the rest of the line still survive.
 */
const SECRET_LABEL =
  'access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|apikey|' +
  'short[_-]?code|password|passwd|credential|signature|secret|token|pwd|code|key|sig';

/** `?token=…`, `SECRET=…` — the value stops where a query string or a quote does. */
const LABELLED_EQUALS = new RegExp(
  String.raw`\b(${SECRET_LABEL})(\s*=\s*)(?!\[redacted\])[^\s&#"'\`,;<>\\]+`,
  'gi',
);

/**
 * `code:  AHHZEKJQ`, `"token": "…"` — one whitespace-delimited value.
 *
 * The optional quotes are what make a `JSON.stringify`'d object work: the
 * logger's `describe()` turns anything that is not a string or an Error into
 * JSON, so a logged options object is a shape this has to read.
 */
const LABELLED_COLON = new RegExp(
  String.raw`\b(${SECRET_LABEL})("?\s*:\s*"?)(?!\[redacted\])[^\s"'\`,;)\]}<>]+`,
  'gi',
);

/**
 * Below this a run is too short to be a credential worth this rule's false
 * positives; the labelled rules above are what catch the short ones.
 */
const MIN_RUN = 20;
/** Half a sha256 and the whole of a UUID; below it, this repo's own ids. */
const MIN_HEX_RUN = 32;
/** Chunks this short are dates, ordinals and initials, never a token's. */
const MAX_NAME_CHUNK = 6;
/** A word flips case where a new word starts; base64 flips wherever bytes fall. */
const CHARS_PER_CASE_FLIP = 5;
/**
 * A word carries a vowel every few letters; random letters carry 5 in 26.
 *
 * One in four is the line, and it was measured rather than picked. Every
 * letters-only chunk this rule inspects, taken off every identifier and log
 * string in `apps/server/src`, `apps/display/src` and `packages/*` — 180 of
 * them — sits at **or above** exactly one in four: `SNAPSHOT`, `MATCHERS`,
 * `starting` and `brotliDecompressSync` are all 0.250, and nothing real is
 * below. The median chunk of a real base64url token is 0.176.
 *
 * So the comparison is `<`, not `<=`, and it is written as `vowels * 4 <
 * letters` rather than as a ratio: `2/8` and `5/20` are the values it turns on
 * and integers cannot round them the wrong way.
 */
const MIN_VOWELS_PER_WORD = 4;

/**
 * A run of the characters an encoder emits — deliberately *without* `/`.
 *
 * Standard base64 uses it, but so does every path, and including it welded
 * `/data/maverick-2026-08-26T09-00-00-000Z.db` into one 38-character run that
 * no per-chunk rule could read as a name. A base64 secret carrying a slash
 * simply arrives as two runs instead of one, and at these lengths both halves
 * are still caught; a redacted database path is a bug report that cannot say
 * which file the server opened.
 */
const HIGH_ENTROPY_RUN = /[A-Za-z0-9+=_-]{20,}/g;

/**
 * How dense a string's case changes are, against the density a name has.
 *
 * The divisor was swept rather than picked: at one flip per five characters
 * nothing in a corpus of this repository's own longest identifiers is flagged
 * — `MaverickWallDisplayEditor`, `AndroidTVWebViewKioskShell`,
 * `SQLITE_CONSTRAINT_PRIMARYKEY` — and a token still has to be unusually
 * word-shaped to get under it.
 */
function isChaoticCase(text: string): boolean {
  return caseTransitions(text) > Math.max(1, Math.floor(text.length / CHARS_PER_CASE_FLIP));
}

/** Where a lowercase letter is followed by an uppercase one. */
function caseTransitions(chunk: string): number {
  let count = 0;
  for (let i = 1; i < chunk.length; i++) {
    if (/[a-z]/.test(chunk[i - 1] as string) && /[A-Z]/.test(chunk[i] as string)) count++;
  }
  return count;
}

/**
 * A chunk of a hyphen/underscore-separated run that reads as a name.
 *
 * `SQLITE_BUSY_SNAPSHOT` is twenty characters and is precisely what this
 * export exists to carry; so are `p12-calendar-webhook` and
 * `maverick-2026-08-26T09-00-00-000Z`. Letters with at most a short numeric
 * tail, digits alone, or anything short enough to be a date field.
 *
 * The last two clauses were measured rather than reasoned, and each closed a
 * hole the one before it left.
 *
 * **Case flips.** Without them, "letters with a numeric tail" admitted
 * `XUhHXrUpjNnJZUllwBYOJb` — which is not a word, it is twenty-two characters
 * off the front of a real display token — and about one real setup token in a
 * hundred survived this file untouched. A word changes case where a new word
 * begins, so `MaverickWall` flips once in twelve characters; base64 flips
 * wherever the bytes fall.
 *
 * **Vowels.** Case flips alone still let one token in 446 through, because a
 * random run that happens to change case gently reads as one long word. That
 * number is not hypothetical: it is why `redact.test.ts` failed on roughly one
 * CI run in five, and the failing assertion was right — the rule was the thing
 * that was wrong. Every length cap that would have closed it was measured
 * first and rejected: at 24 characters it redacts `MaverickWallDisplayEditor`
 * and `AndroidTVWebViewKioskShell`, which are precisely the names this
 * function exists to protect. Vowel density separates them where length
 * cannot, and it does so with room to spare — one real token in 1,818 now
 * survives, and **not one** of the 304 real identifiers in this repository
 * changed side.
 *
 * The order matters: the cheap shape tests come first, and vowels before case
 * flips only because a starved chunk is the commoner miss.
 */
function isNameChunk(chunk: string): boolean {
  if (chunk.length <= MAX_NAME_CHUNK) return true;
  if (/^[0-9]+$/.test(chunk)) return true;
  if (!/^[A-Za-z]+[0-9]{0,4}$/.test(chunk)) return false;
  if (vowelStarved(chunk)) return false;
  return !isChaoticCase(chunk);
}

/**
 * Whether a chunk has too few vowels to be a word somebody wrote.
 *
 * Digits are not counted either way: a numeric tail is not evidence about the
 * letters in front of it.
 */
function vowelStarved(chunk: string): boolean {
  const letters = chunk.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return false;
  return (letters.match(/[aeiouAEIOU]/g) ?? []).length * MIN_VOWELS_PER_WORD < letters.length;
}

/** How many of lowercase, uppercase and digits a run draws on. */
function alphabets(run: string): number {
  return (
    (/[a-z]/.test(run) ? 1 : 0) + (/[A-Z]/.test(run) ? 1 : 0) + (/[0-9]/.test(run) ? 1 : 0)
  );
}

/**
 * Whether a run of token characters is a credential rather than a word.
 *
 * Two shapes. A digest or a UUID is hex and long — every hash in this
 * repository is `sha256(…).digest('hex')`, and the ids are eight bytes, which
 * is sixteen characters and deliberately below the bar. Anything else has to
 * fail to read as a name, whether the name is read as one string or as
 * separated words.
 *
 * Measured against two hundred thousand tokens from this repository's own
 * generators, about one in 1,818 still reads as a word and survives. That is
 * the honest bar for this rule and it is deliberately not the defence: it is
 * the backstop for a credential nobody labelled. Everything this codebase
 * actually prints is caught by the labelled rules above, deterministically,
 * whatever the random bytes happen to be — `redact.test.ts` drives the real
 * boot lines through `redactLogText` to say so, which is the assertion that
 * can honestly be made at 100%.
 */
export function looksLikeSecret(run: string): boolean {
  if (run.length < MIN_RUN) return false;
  const undashed = run.replace(/-/g, '');
  if (undashed.length >= MIN_HEX_RUN && /^[0-9a-f]+$/i.test(undashed)) return true;
  // Read as one string, ignoring separators. This is what catches a base64url
  // token that happens to carry several `-` or `_`: split into chunks, each
  // piece is short enough to pass for a word, and the chunk rule below lets
  // the whole thing through. Measured, that was most of what still escaped.
  if (isChaoticCase(run.replace(/[-_]/g, ''))) return true;
  // Read as separated words, which is what an error code or a path segment is.
  if (run.split(/[-_]/).every(isNameChunk)) return false;
  // A name that reached here is lowercase with digits in it — `ics_sync_2026w34`
  // splits into a chunk no rule above will vouch for, and is still a name. A
  // credential draws on more of the alphabet than that.
  return alphabets(run) >= 3 || (/[a-z]/.test(run) && /[A-Z]/.test(run));
}

/**
 * One log line's text, with credentials replaced and everything else kept.
 *
 * Order matters: the header rules run first so that `Authorization: Bearer …`
 * is one redaction rather than a label rule eating the scheme and leaving the
 * value behind it.
 */
export function redactLogText(text: string): string {
  return text
    .replace(CREDENTIAL_HEADERS, `$1$2${REDACTED}`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(LABELLED_EQUALS, `$1$2${REDACTED}`)
    .replace(LABELLED_COLON, `$1$2${REDACTED}`)
    .replace(HIGH_ENTROPY_RUN, (run) => (looksLikeSecret(run) ? REDACTED : run));
}

/** The log tail as the export may carry it. Timestamps and levels are untouched. */
export function redactLog(lines: readonly LogLine[]): readonly LogLine[] {
  return lines.map((line) => {
    const text = redactLogText(line.text);
    return text === line.text ? line : { ...line, text };
  });
}
