/**
 * What stops discovery walking off with the household's password (RFC 013
 * §6.3.1).
 *
 * The discovery chain is **server-directed twice**: the well-known redirect
 * chooses the context path, and `calendar-home-set` chooses the host the
 * calendars live on. We attach an app-specific password to every hop after the
 * first. So "follow the discovery wherever it points and send the credential
 * there" is a credential-disclosure primitive with the SSRF guard's own shape —
 * and the guard does not cover it. The guard stops *internal* addresses and DNS
 * rebinding; it has nothing to say about an Apple ID password being posted to a
 * public host a hostile server nominated.
 *
 * It cannot simply be refused, because iCloud requires exactly that move:
 * `caldav.icloud.com` is what a household types and `pNN-caldav.icloud.com` is
 * where their calendars are.
 *
 * **Same host is silent, a different host is confirmed once and stored.**
 *
 * This file is that rule and nothing else — pure, no I/O, no Fetcher, for the
 * reason `widget-options.ts`, `ink.ts`, `ladder.ts`, `placement.ts` and
 * `omission.ts` are pure: a policy that lives inside a handler is a policy a
 * test can only reach through a server, one case at a time. The whole of it can
 * be read down at once and the bypass table in `caldav-host-policy.test.ts` is
 * written against it directly.
 *
 * **The tempting alternative is rejected and it is worth saying why**, because
 * it is what a reviewer will propose. "Same registrable domain" would be silent
 * for iCloud too, and it needs a real public-suffix list: a dependency plus a
 * data file that goes stale. Approximating it as the last two labels is wrong
 * in the *dangerous* direction — it judges `cal.someone.co.uk` and
 * `evil.co.uk` to be the same site, and sends the password to the second. A
 * rule that is silently wrong for one country's households is worse than a rule
 * that asks one question. A public-suffix list is a non-goal (§13).
 */

/**
 * A host, as this policy compares them: lowercased, with a trailing dot
 * removed, and **with the port**.
 *
 * The port is in deliberately. `isCrossOrigin` in core counts a port change as
 * an origin change and this has to agree with it, or a redirect that drops the
 * credential would be one this policy called silent — two guards with two
 * opinions about one hop, which is the shape of every bug in this repository's
 * own table. A household running Nextcloud on `:8443` and a stranger on `:80`
 * of the same name are not the same destination.
 *
 * The scheme is deliberately *out*. `allowHttp` is what decides whether plain
 * HTTP is acceptable at all, per source, and it decides it for every hop; a
 * host policy that also had an opinion would be a second answer to a question
 * already settled.
 */
export function hostKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // `URL` already lowercases and punycodes the hostname, so a lookalike written
  // in a different script normalises the same way DNS will be asked for it.
  const host = parsed.hostname.replace(/\.$/, '');
  if (host === '') return undefined;
  return parsed.port === '' ? host : `${host}:${parsed.port}`;
}

export type HostDecision =
  /** Stay on the host the household typed, or one they have already confirmed. */
  | { readonly status: 'proceed' }
  /**
   * Stop before the credential is sent. The caller re-renders its form as a
   * confirmation naming this host, and stores the answer.
   */
  | { readonly status: 'needs-confirmation'; readonly host: string }
  /** An address this policy cannot read at all, which is never a proceed. */
  | { readonly status: 'unreadable'; readonly url: string };

export interface HostPolicyInput {
  /** The address the household typed. Its host is the one that is silent. */
  readonly typedUrl: string;
  /** Where the chain wants to go next. */
  readonly nextUrl: string;
  /**
   * A host the household has already been shown and accepted, as stored on the
   * account. One, not a list: the chain moves at most once in practice, and a
   * list is a thing that grows by one silently every time a server points
   * somewhere new.
   */
  readonly confirmedHost?: string | null | undefined;
}

/**
 * Decide whether the credential may go to `nextUrl`.
 *
 * Never throws and has no default-allow branch: every path ends in one of the
 * three variants, and the only one that proceeds is an exact host match against
 * the typed address or the stored confirmation.
 */
export function decideHost(input: HostPolicyInput): HostDecision {
  const typed = hostKey(input.typedUrl);
  const next = hostKey(input.nextUrl);

  /*
   * An address neither of us can read is `unreadable`, never a proceed.
   *
   * That is the direction rule nine takes everywhere else: a check that could
   * not run does not get to answer yes. It costs a household a sentence and it
   * cannot cost them a password.
   */
  if (next === undefined) return { status: 'unreadable', url: input.nextUrl };
  if (typed === undefined) return { status: 'unreadable', url: input.typedUrl };

  if (next === typed) return { status: 'proceed' };

  const confirmed =
    input.confirmedHost === null || input.confirmedHost === undefined
      ? undefined
      : // Normalised through the same function that produced it, so a stored
        // value written by an older shape — or by hand — cannot proceed on a
        // spelling this comparison would not otherwise accept.
        hostKey(`https://${input.confirmedHost}`);
  if (confirmed !== undefined && next === confirmed) return { status: 'proceed' };

  return { status: 'needs-confirmation', host: next };
}
