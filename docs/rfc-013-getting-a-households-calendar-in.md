# RFC 013 — Getting a household's calendar in

Status: **proposed; nothing built** · Owner: — · First drafted 2026-09-13 ·
Relates to `apps/server/src/db/schema.ts` (`calendar_sources`),
`apps/server/src/api/test-feed.ts`, `apps/server/src/jobs/ics-sync.ts`,
`apps/server/src/jobs/ha-calendar-sync.ts`,
`apps/server/src/modules/homeassistant/calendars.ts`,
`packages/core/src/net/url.ts`, `packages/core/src/ports/fetcher.ts`,
`apps/server/src/net/fetcher.ts` · Shares one Fetcher change with RFC 012

## 1. Summary

The product has exactly two ways to get events in: an ICS address, and a Home
Assistant calendar entity. That covers more households than it looks — but it
leaves three of the four calendars people actually use reachable only by
finding a secret URL, and one of them (iCloud) not reachable at all except
through Home Assistant.

This RFC is the answer to "can we do a Google login", and the short version is
**no, and not for a reason we can engineer around** — a self-hosted product
cannot hold an OAuth client credential, and Google has closed every flow that
does not need one. §7 is that argument in full, written down once so it is not
relitigated every six months.

What we can do, in increasing order of cost:

- **A feed can have a password** (§4). Two columns and two form fields. Unlocks
  Nextcloud completely, plus Baïkal, Radicale, SOGo, Fastmail and every school
  or work feed behind Basic auth. **No new HTTP method, no new dependency, no
  protocol work at all** — because Nextcloud serves a whole calendar as `.ics`
  from its own collection URL.
- **Say that the Home Assistant route exists** (§5). Google, iCloud, Microsoft
  365 and Nextcloud all reach the wall today through `kind = 'homeassistant'`,
  and nothing in the product says so. This is copy, not code.
- **CalDAV** (§6), which is the only direct door to iCloud, the only part of
  this RFC that is a real project, and **committed** — because what an iCloud
  household is told to do today is either "install Home Assistant" or "publish
  your family calendar unauthenticated".
- **Microsoft 365 by device code** (§8), which is the one OAuth that actually
  fits a kitchen appliance — noted, not proposed.

## 2. The question, stated honestly

"Can we add a Google login" is three separate requests wearing one sentence,
and they have different answers:

1. **"I do not want to hunt for a secret ICS address."** Legitimate, and the
   commonest. Google puts the public HTML link and the secret iCal link side by
   side in the same settings panel and only one of them works — `testFeed`'s own
   docstring already names this as the reason it exists.
2. **"I want my calendar to update promptly."** A Google secret ICS is cached by
   Google, and hours of staleness is routinely reported. That is a real
   complaint and OAuth would genuinely fix it.
3. **"I want it to feel like signing in."** This one cannot be delivered
   self-hosted, and §7 explains why in a way that should be readable by somebody
   who does not already believe it.

Phase A and B answer (1) for everybody except Google and iCloud users. §5
answers (2) for a household with Home Assistant. Nobody gets (3).

## 3. Constraints, and why they decide the shape

**The Fetcher is GET-only.** `net/fetcher.ts:338` hardcodes `method: 'GET'` and
`FetchRequest` (`ports/fetcher.ts`) has no `method` and no `body`. Rule 4
routes every user-supplied URL through this one adapter. So the dividing line
through this whole RFC is *which providers need a method other than GET* — and
it turns out to separate Nextcloud (no) from iCloud (yes) far more cleanly than
anybody would guess from the outside.

**`kind` is already the seam.** `calendar_sources.kind` is `'ics' |
'homeassistant'` with a comment explaining why it is a kind and not a second
table, and `ha-calendar-sync.ts` describes itself as "the same job as an ICS
feed with a different way of getting the bytes". A third kind is a job and a
branch in `main.ts:670-674`; the manifest, the display, the shift matcher and
the health notices never learn it exists.

**The per-source network opt-ins already exist.** `allowPrivateNetwork`,
`allowLoopback` and `allowHttp` are columns on `calendar_sources`, per source,
each off by default. A household's Nextcloud on the LAN is already a supported
destination. It simply cannot authenticate.

**`testFeed` is the product's best screen and a new kind has to earn its way
into it.** "Fetch it, parse it, and show them their own events. If their
calendar comes back, it is right." Any provider added here that cannot be
tested before it is saved is a provider that fails silently an hour later,
which is the exact failure `testFeed` was built to remove.

**There is no cloud.** Not a preference — CLAUDE.md's second line. It is the
single fact that kills Google OAuth, because every remaining Google flow needs
a redirect URI that a household's LAN address cannot be.

## 4. Phase A — a feed can have a password

### 4.1 What two form fields buy

| Provider | Address | Credential |
|---|---|---|
| **Nextcloud** | `…/remote.php/dav/calendars/<user>/<cal>?export` | app password |
| Baïkal, Radicale, SOGo | collection URL, same shape | app password |
| Fastmail | published/authenticated ICS | app password |
| School, work, council feeds | whatever they gave you | whatever they gave you |

**Nextcloud is the headline and it needs no CalDAV.** SabreDAV's
`ICSExportPlugin` serves an entire calendar collection as a single `.ics` when
the URL carries `?export`, and Basic auth works against it. That is a plain GET
of a plain ICS body — the existing job, the existing parser, the existing
conditional-request machinery, the existing `testFeed`. The only thing missing
is somewhere to put a username and a password.

That is worth stating plainly because the obvious plan is "build CalDAV, it
gets Nextcloud and Apple together". It does, and it gets Nextcloud for roughly
forty times the work.

### 4.2 What it costs

Migration **0042** (0041 is RFC 012's), additive, two columns on
`calendar_sources`:

- `authUsername` — in clear. It is a username; the admin screen has to show
  which account a feed uses, and the same reasoning `haEntityId` records
  applies.
- `authPasswordEncrypted` — a keyring envelope, new purpose `feed-password`.

Then: two fields on the add/edit form, two on `TestFeedRequest`, an
`authorization: Basic …` header on the fetch in `ics-sync.ts` and in
`test-feed.ts`, and `--user` on the `add-source` CLI tool.

**These columns live on `calendar_sources` deliberately, and stay there.** A
Basic-auth ICS feed genuinely is one URL, one credential, one calendar — flat
is the true shape, and routing it through the accounts table §6.2 introduces
would turn this phase from two columns into a table and a join for the common
case. §6.2 is the exception, not the correction.

The header path needs nothing new: `FetchRequest.headers` already exists, the
HA client already uses it for a bearer token, and `SENSITIVE_HEADERS`
(`fetcher.ts:57`) already drops `authorization` on a cross-origin redirect —
which is exactly the case that would otherwise hand a household's Nextcloud
password to wherever a redirect pointed.

### 4.3 What a credential in a URL is, and the sentence that goes stale

`validateOutboundUrl` already refuses userinfo (`core/src/net/url.ts:177`), for
two good reasons stated at the check: storing it is a bad idea, and `user@host`
is a parser-confusion trick where the part a person reads as the host is the
username. **Both reasons survive this change and the refusal stays.** A
household pastes `https://me:pw@nextcloud.example/…` and is told to use the
fields.

But its remedy sentence does not survive:

> Remove the username and password from the address. If the feed needs
> credentials, it should carry them in a token in the path.

That is true today and wrong the day Phase A ships, and it is wrong in the
worst direction — it tells somebody holding a Nextcloud app password that this
product has no way to use it. It becomes "…enter them in the Username and
Password fields below." Listed here rather than left to be found, because it is
one sentence in a pure package with no view of the form it is describing.

Worth noting what else shifts. `urlEncrypted`/`urlHost` exist because "the path
is the credential" — a Google secret iCal address is a permanent bearer token
and `/data` is what people copy to a NAS. For a **credentialed** feed that
stops being true: the URL alone is useless without the password, which is a
genuine reduction in what a leaked database row is worth, traded for a second
secret to store. Both are keyring envelopes, so the trade is even and the
comment on `urlEncrypted` should say so rather than implying every feed URL is
a password.

### 4.4 The one thing to get right in `testFeed`

A 401 must not be reported as "that address did not answer". `testFeed`'s
`suggestionFor` maps codes to sentences somebody standing in a kitchen can act
on, and a 401 with credentials supplied and a 401 with none are different
diagnoses: *the password is wrong* against *this calendar needs a password, and
here is where to put it.* Both are one clause, and getting them wrong turns the
best screen in the admin into a shrug.

## 5. Phase B — the route that already works, that nothing mentions

`kind = 'homeassistant'` consumes any `calendar.*` entity, and Home Assistant
has integrations for Google Calendar, CalDAV (iCloud, Nextcloud, Baïkal,
Radicale), Microsoft 365, Remote Calendar (ICS/webcal, 2025.4+) and Local
Calendar. So **Google and iCloud both reach a Maverick Wall today**, with Home
Assistant doing the OAuth, and nothing in this product tells anybody that.

For an add-on household this is close to free — `calendars.ts` already calls it
"the onboarding win: their calendars are already in Home Assistant, and they
add them here without finding a single ICS address" — and the Home Assistant
screen is the only place it is said. It belongs on the **Calendars** screen,
which is where somebody stands when they have this problem.

Two honest caveats, both of which belong in the copy rather than in a footnote:

- **It can be staler than a direct feed.** HA's Remote Calendar polls every 24
  hours. A household chasing complaint (2) from §2 by routing Google through
  HA's *Remote Calendar* has made it worse; through HA's *Google Calendar*
  integration, much better. The copy has to distinguish those, which means
  naming HA integrations in our own admin — mildly awkward and better than the
  alternative.
- **It is another thing that can be down.** A feed failing is one calendar;
  Home Assistant failing is all of them. `ha-calendar-sync.ts` already handles
  this correctly — every failure path leaves the expanded events in place — but
  the household should know they have coupled their calendar to their smart
  home.

One genuine bonus, worth knowing before anybody optimises the wrong thing:
**Home Assistant expands recurrence itself.** `/api/calendars/<entity>` takes a
start and an end and returns concrete instances, so this path never touches
`expandCalendar` and sidesteps the ~45ms-per-year-of-distance cost CLAUDE.md
records for old recurring series. For a household with a fifteen-year-old
weekly event, the HA route is measurably cheaper than the ICS one.

## 6. Phase C — CalDAV, for Apple

### 6.1 iCloud has no other door

Apple has no calendar API, no OAuth for calendars, and no personal access
tokens. CalDAV against `https://caldav.icloud.com` with an Apple ID and an
**app-specific password** is the entire surface, and it is what Home
Assistant's own caldav integration does.

Everything else CalDAV would reach, Phase A reaches with a GET. So this phase
is for one provider, and an earlier draft framed it as being "for households
who want their iCloud calendar and do not run Home Assistant" — which
undersells it by describing the population rather than what that population is
currently told to do.

**What an iCloud household is told to do today is the argument.** Their two
options are install Home Assistant, or use a public iCloud share link — and a
public share link is **unauthenticated**: anyone holding the URL reads the
family's calendar. That is the same bearer-URL risk class `calendar_sources`
already names at `urlEncrypted`, where a feed address is described as "a
password in a URL". Recommending it is this product advising a household to
publish their children's school run to the internet, and it is the answer in
the "works today" column of the matrix in Appendix A.

So Phase C is **committed** rather than costed-and-deferred. It is weeks of
work, a widened security boundary, a new parser and a new table, for one
provider — and the alternative is a privacy answer this product should not be
giving. What §11 still gates is the *schema*, not the phase: §6.2.1 rests on
households having more than one calendar per account, and that is cheap to
check before the table is written and expensive after.

### 6.2 The discovery chain, and what gets stored

RFC 6764 plus RFC 4791, four round-trips before a single event:

1. `GET`/`PROPFIND` `/.well-known/caldav` → a 301/303/307 to the context path.
2. `PROPFIND` there, `Depth: 0`, for `DAV:current-user-principal`.
3. `PROPFIND` on the principal for `CALDAV:calendar-home-set`.
4. `PROPFIND` on the home set, `Depth: 1`, for each collection's
   `resourcetype`, `displayname` and `supported-calendar-component-set`.

On iCloud the home set lands on a **per-account partition host** —
`pNN-caldav.icloud.com`, with a numeric account id in the path — so nothing
about the address can be predicted and the discovery is not skippable. This
also means the guard sees a different hostname at step 3 than the household
typed, which is correct and must not be treated as a redirect off-origin.

Discovery runs **once, at add time**, and the resolved collection URL is
stored. Sync is then one `REPORT` per source. That turns the four-request chain
into a setup cost rather than a per-poll cost, and it is the difference between
CalDAV being viable here and not.

### 6.2.1 One credential, several calendars — and the schema has no word for it

Decided, and worth the space, because it is the one place CalDAV does not fit
the existing shape.

An ICS feed is one URL to one calendar, and `calendar_sources` is exactly that.
A CalDAV account is **one credential to many calendars**: a household types an
Apple ID and one app-specific password, and what comes back is Home, Work,
Kids' school and Birthdays. Three of those go on the wall, in different
colours, with Work off the month grid.

Asking of each existing column whether it is a fact about the account or about
the calendar splits them cleanly, and the answer is that almost everything is
already in the right place:

| Column | Belongs to | Why |
|---|---|---|
| `name`, `color`, `personId` | calendar | Work is a different colour from Kids, and is one person's where Kids is the household's |
| `visible`, `showInGrid` | calendar | `show_in_grid` exists precisely to keep a work feed off the month squares; per-account it would be useless |
| `etag`, `lastSyncAt`, `lastError`, `consecutiveFailures`, `eventCount` | calendar | the CTag is per collection, and one calendar failing must not blank the others |
| `urlEncrypted` | calendar | the collection href |
| username and password | **account** | one credential for all four |
| `allowHttp`, `allowPrivateNetwork`, `allowLoopback` | **account** | it is one server |
| discovered principal and home-set URLs | **account** | discovered once, per account |

Only the three bold rows have nowhere correct to live. So: a
**`caldav_accounts`** table holding them, and `calendar_sources` gains a
nullable `caldav_account_id`. `kind` gains `'caldav'`.

**What decides it is password rotation.** Apple app-specific passwords get
regenerated, and under a flat scheme — each row carrying its own copy of the
same envelope — a household then has to edit four rows with the same new
password. Miss one and a single calendar silently stops syncing, which presents
as "one of my calendars stopped updating": about the hardest fault for a
household to describe and for `diagnose-source` to be pointed at.

The second argument is the add flow §6.7 already needs. "Here is your account,
here are its calendars, tick the ones you want" has nowhere to come back from
if the account is not a row: a household who adds three calendars in March and
wants a fourth in June would have to retype the password, because there is
nothing to reopen.

Rejected outright: **one `calendar_sources` row per account**, drawing all its
calendars. It gives a whole account one colour, one person and one
`show_in_grid`, which breaks the column that exists to fix the standup fault.

**The assumption this rests on, stated rather than buried:** that households end
up with more than one calendar per CalDAV account. If they reliably add exactly
one, the parent table is a table, a join, an admin concept and a cascade rule
bought for nothing. It looks safe for iCloud, which creates Home and Work by
default and where families acquire a shared one — but it is an assumption, and
§11 puts it in front of a real account before Phase C's schema is written.

Two consequences settled in the same commit rather than discovered:

- **Removing an account's last calendar removes the account and its
  credential.** An orphaned credential is a stored secret nothing uses, which
  is the spirit of rule 6. A household wanting a calendar back temporarily has
  `enabled` and `visible`; removal is removal.
- **Each calendar syncs on its own job**, `caldav-sync:<sourceId>`, matching
  `ics-sync:<id>` — because the CTag is per collection and one failing calendar
  must not take three working ones down. Only *discovery* is per account, and
  it is cached on the account row.

The migration is additive: one `CREATE TABLE` and one nullable
`ALTER TABLE ADD COLUMN`. No table recreate, so rule 7's `0009` hazard — the
generated `INSERT … SELECT` that silently writes column *names* as string
literals — does not apply here. That is worth checking rather than assuming,
because it is the one migration fault in this repository that reported success.

### 6.2.2 Two storage locations, one resolver

Phase A's credential is on `calendar_sources` and Phase C's is on
`caldav_accounts`, which is normally the exact shape of bug this project keeps
finding: one meaning, two places, two readers that drift.

The cure is already in the repository. `resolveConnection`
(`modules/homeassistant/client.ts`) handles two credential paths — the
supervisor's injected token and a pasted long-lived one — by resolving them in
**one function**, and everything downstream is the same code. Its own docstring
is the heading: *two credential paths, one client.*

So `credentialFor(source)` answers "the `authorization` header for this source",
reading the account through the FK first and the row's own columns second. The
sync jobs, `testFeed` and the CLI all call it and none of them knows there are
two shapes — which means there is one thing to test rather than three call
sites to keep in step.

**Phase C should not ship before Phase A**, and this is the reason: the resolver
needs both shapes to exist before it is worth anything, and building C first
would invent a second way to store a feed password with nothing to reconcile it
against.

### 6.3 The Fetcher, again — and it is the same change RFC 012 needs

`PROPFIND` and `REPORT` with XML bodies. This is the second RFC in a row whose
real cost is one widening of the single guarded boundary, and the two should be
designed together even if they ship apart.

RFC 012 §4 proposes a narrow `postJson`. The generalisation this needs is a
**fixed method allowlist** — `POST`, `PROPFIND`, `REPORT` and nothing else —
with the body always constructed from first-party templates and validated ids,
never from anything household-authored. Same `UrlPolicy`, same DNS pin, same
byte ceiling, same `SENSITIVE_HEADERS` stripping.

One difference from RFC 012: **CalDAV must follow redirects** (step 1 is
specified as one) where `postJson` refuses them. So the allowlist carries a
per-method redirect policy rather than one rule, and `SENSITIVE_HEADERS` keeps
dropping `authorization` across an origin change. What re-attaches it, and on
what authority, is §6.3.1 — and that is a security decision rather than a
transport detail, which is why it has a section of its own rather than a clause
in this one.

### 6.3.1 What stops discovery walking off with the password

The discovery chain is **server-directed twice**: the well-known redirect
chooses the context path, and `calendar-home-set` chooses the host the
calendars live on. We attach the household's app-specific password to every hop
after the first. So "follow the discovery wherever it points and send the
credential there" is a credential-disclosure primitive with the SSRF guard's
own shape — and the guard does not cover it. The guard stops *internal*
addresses and DNS rebinding; it has nothing to say about an Apple ID password
being posted to a public host a compromised or hostile server nominated.

It cannot simply be refused, because iCloud requires exactly that move:
`caldav.icloud.com` is what the household types and `pNN-caldav.icloud.com` is
where their calendars are.

**Decided: same host is silent, a different host is confirmed once and
stored.** Discovery that stays on the host the household typed — Nextcloud,
Baïkal, Radicale, every self-hosted server — asks nothing and looks exactly
like adding a feed. Discovery that moves stops the add flow, names the host it
was sent to, and asks. The answer is stored on `caldav_accounts` beside the
credential, so every later sync goes straight there and nothing re-asks. **The
credential is not sent before that decision**, which is free: step 1 needs no
authentication.

That is the shape `allowHttp` and `allowPrivateNetwork` already have — a
deliberate per-source decision, made once, on the screen where somebody is
already paying attention — rather than a global rule nobody sees.

**The tempting alternative is rejected and it is worth saying why**, because it
is what a reviewer will propose. "Same registrable domain" would be silent for
iCloud too, and it needs a real public-suffix list: a dependency plus a data
file that goes stale. Approximating it as the last two labels is **wrong in the
dangerous direction** — it judges `cal.someone.co.uk` and `evil.co.uk` to be
the same site, and sends the password to the second. A rule that is silently
wrong for one country's households is worse than a rule that asks one question.

### 6.4 Do not let the server expand

CalDAV's `calendar-data` accepts a `<C:expand>` element asking the server to
expand recurrences, and both iCloud and SabreDAV support it. It is tempting: it
would make this path as cheap as the Home Assistant one.

**Refuse it.** `packages/calendar` is this repository's most heavily tested
package and every rule in it is a decision a provider's expander makes
differently — recurrence computed on wall-clock and then anchored, `DTEND`
exclusive, zones from `Intl` rather than from a feed's own stale VTIMEZONE.
Accepting server expansion means a household's birthday lands on a different
day depending on which provider they use, and the one tested recurrence engine
in this repository stops being on the path.

The time-range filter on `calendar-query` is a different matter and should be
used: it cuts which *resources* come back without touching how they are
interpreted.

### 6.5 One resource per event is a feature

In CalDAV each event resource is a complete `VCALENDAR` holding the master
`VEVENT` and its `RECURRENCE-ID` overrides together. So `expandCalendar` is
called **once per resource** rather than once per feed.

That is not a workaround, it is better than what we have: the first row of
CLAUDE.md's bug table is "One malformed event killed a whole feed", found by a
hostile synthetic fixture. Per-resource parsing makes that structurally
impossible for a CalDAV source — one bad resource costs one event. The cost is
N parser invocations for N series, which on a real calendar is hundreds of
small blobs rather than one 3.2MB one, and should be measured rather than
assumed.

### 6.6 CTag maps onto a column we already have

`calendar_sources.etag` and `lastModified` exist for conditional GETs. CalDAV's
equivalent is the collection's CTag (`CS:getctag`) — one cheap `PROPFIND` that
answers "has anything in this calendar changed" — which fits the existing
column with no schema change and no new concept.

RFC 6578's `sync-collection` with a sync-token is the better mechanism and
gives incremental changes rather than a yes/no. It is the optimisation, not the
first version, and support should be *detected* rather than assumed: the
correct behaviour on a server that does not advertise it is to fall back to
CTag, and the correct behaviour on one that does is to be measured before being
relied on.

### 6.7 What `testFeed` grows

A fourth stage. Today it is `'url' | 'fetch' | 'parse'`; CalDAV adds
`'discover'`, and the distinction is the whole value: *the address is fine and
the password is wrong* is a completely different sentence from *you are signed
in and that account has no calendars*, and both are different from *the address
is not a CalDAV server*. Collapsing them into "could not connect" would reduce
the best screen in the admin to the worst kind of error.

It also grows a step the ICS path does not have: **a CalDAV account has several
calendars and the household has to choose.** That is a picker between test and
save — closer to the Home Assistant calendar-entity flow than to pasting a URL,
and it should reuse that screen's shape rather than inventing one.

### 6.8 Reading the XML, and why it is hand-rolled

`PROPFIND` and `REPORT` answer with WebDAV `multistatus` documents, and
something has to read them. This project's own rule points both ways — "draw
what nobody else supplies, and use somebody else's work for what is already
solved" is the Oswald decision, and XML parsing is solved — so it is worth
saying which side this lands on and why.

**Decided: a strict, non-general reader in `apps/server`, hand-rolled.** Two
arguments, and the second is the one that settles it.

The narrow one: what is needed is not "parse XML", it is "read a handful of
known element paths out of a multistatus response". That is the same gap
`qr.ts`, `png.ts` and `font.ts` already sit in — a general library for a
specific need — and this project has taken that side four times.

The one that actually decides it: **XXE is the canonical WebDAV and SOAP
vulnerability**, and a general parser has to be *configured* not to be
vulnerable to it. A reader with no concept of entities and a flat refusal of
`DOCTYPE` cannot have XXE at all. That inverts the usual instinct about
hand-rolling a parser: here the narrow thing is the safer thing, because the
dangerous feature is one it does not implement rather than one it disables.

So: `DOCTYPE` refused outright, no entity expansion of any kind, prefix→URI
namespace mapping read from the declarations rather than from assumed prefixes,
a hard depth cap and the Fetcher's byte ceiling above it. Pure, no I/O, in
`apps/server` — rule one keeps it out of the pure packages and there is nothing
here `packages/calendar` wants.

**The honest risk is correctness rather than security**, and §11 names it: a
reader that handles one server's prefixes and not another's works against
Nextcloud and fails against iCloud. `d:`, `D:` and the default-namespace form
all occur in the wild. Real fixtures from both providers are the mitigation,
and they are needed whichever way this went.

A public-suffix list is a **non-goal** for the same family of reasons (§6.3.1),
and both are listed in §13 so that "we could just add a small dependency"
arrives as a reopening rather than as a convenience.

## 7. Google, refused

Four blockers, each independently sufficient. They are recorded together
because each one alone invites "well, what if we…".

**1. We cannot ship a client secret.** Rule 6 forbids it in the repo or the
image, and a public repository makes it academic. So the household creates a
Google Cloud project and an OAuth consent screen — precisely the friction Home
Assistant's own Google integration carries, and the reason most people who try
it give up.

**2. The device flow is not available for Calendar.** Google's limited-input
device flow is restricted to `email`, `openid`, `profile`, Drive `appdata` and
`file`, and two YouTube scopes. Calendar is not on the list. So the one journey
that suits a kitchen appliance — "open this page on your phone and type this
code" — is closed, and it is closed by policy rather than by anything we could
work around.

**3. The out-of-band flow is gone.** `urn:ietf:wg:oauth:2.0:oob` has been
blocked for all clients since 3 October 2022. The copy-the-code-back fallback
does not exist.

**4. The redirect URI cannot be a LAN address.** Google permits
`http://127.0.0.1:<port>` and `http://localhost` for desktop clients, and
otherwise requires HTTPS on a registered domain. The admin is at
`http://192.168.1.10:8080`. Loopback does not help, because the browser doing
the consent is a phone and the loopback would be the phone's own. A public
HTTPS redirect means a cloud component and there is no cloud version.

### 7.1 And the trap for anyone who pushes through anyway

With the consent screen left in **Testing** — which is where it is when
somebody follows a tutorial and stops — Google revokes refresh tokens after
exactly seven days. A household would re-authorise their kitchen calendar every
week, and the failure would present as "the wall stopped updating" rather than
as anything about authorisation.

Avoiding it means publishing the project to Production. Calendar is a sensitive
scope, so that is either the unverified-app warning screen with a 100-user cap,
or full verification of an app that is one household's own Cloud project. That
is a genuinely unreasonable thing to ask of somebody who wants a calendar on a
wall by the end of the afternoon.

### 7.2 What we do instead

The secret iCal address, which works today, and the Home Assistant route, which
works today. Phase B is how a household finds out about the second one. The
staleness of the first is real and should be *said* on the Calendars screen
rather than discovered — "Google refreshes this link on its own schedule, often
hours behind" is one sentence and it converts a mystery into a known trade.

### 7.3 The escape hatch we are deliberately not building

"Bring your own Google client": the household pastes a client ID and secret and
we run the code flow. It is technically possible — Home Assistant does it — and
it is rejected here for three reasons. It is a lot of UI for a journey that
ends on a Google Cloud console page. It is strictly worse than Phase B for
anyone who has Home Assistant. And it puts this project in the position of
explaining Google's console to households in a troubleshooting document, for
ever.

If it is ever built it should be because somebody counted how many people
asked, not because it is the last unticked box.

## 8. Microsoft 365 — the one OAuth that fits

Noted rather than proposed, because it would be the first thing to build if
anybody asks.

Microsoft's device authorization grant accepts arbitrary Graph delegated
scopes, `Calendars.Read` included. A device-code client is a **public client**:
it has a client ID and no secret, so rule 6 is satisfiable with an ID compiled
into the image, and the journey is genuinely "open microsoft.com/devicelogin
and type ABCD-EFGH" — the right shape for a screen with no keyboard.

Three caveats. It needs a multi-tenant app registration this project owns and
maintains, which is a small ongoing operational commitment and the first one
this product would have. Tenant administrators can block unapproved
applications, so work calendars will sometimes refuse and the error has to say
why. And the token exchange is a POST with a form body, so it needs §6.3's
Fetcher change — which is one more reason to design that change once rather
than three times.

Outlook.com personal accounts publish ICS links, which Phase A already covers.

## 9. What none of this changes

Worth stating, because the value of `kind` is that the answer is "almost
everything":

`NormalizedEvent`, `createEventWriter`, `calendar_events_cache`, the manifest,
every widget, the shift matcher's title analysis, the health notices, the
colour and person assignment, `show_in_grid`, the e-paper renderer. A new kind
writes the same rows through the same writer, and nothing downstream can tell.

The one thing that does change for every kind at once is `testFeed`'s result
type, because a fourth stage and a calendar picker are not per-provider
cosmetics. That is the file to review hardest.

## 10. Phases

**A — a feed can have a password.** Migration, two columns, two fields, the
header, the CLI flag, the 401 diagnosis, and the `url.ts` sentence. Days. Gets
Nextcloud and a long tail, with no protocol work and no Fetcher change.

**B — say the Home Assistant route exists.** Copy on the Calendars screen and
in `docs/`. Hours. Gets Google and iCloud for households who have Home
Assistant, which is a large fraction of this product's audience.

**C — CalDAV.** The method allowlist on the Fetcher, the discovery chain, the
`caldav_accounts` table and `credentialFor` (§6.2.1, §6.2.2), the `REPORT`, a
minimal XML reader, the CTag, the fourth `testFeed` stage and the calendar
picker. Weeks, and the only part of this RFC that is a project. Gets iCloud
directly, and is **committed rather than costed** (§6.1) — the alternative for
an iCloud household is an unauthenticated public share link, which is not an
answer this product should be giving. What §11 gates is the schema and not the
phase.

**D — M365 device flow.** Only on demand. Shares C's Fetcher work.

A and B should ship together: A without B leaves Google and iCloud users with
nothing new, and B without A tells Nextcloud users to install Home Assistant.

## 11. How this gets proven (verification is the job)

**A real Nextcloud, not a stub.** `?export` with an app password, against a
container, including the case that has bitten this project before: the redirect
Nextcloud issues when the trailing slash is wrong, and whether `authorization`
survives it. A stub that answers 200 with a fixture proves nothing about
either.

**A wrong password, deliberately.** The 401 diagnosis in §4.4 is the whole of
Phase A's user experience and it is the one thing a happy-path test cannot see.
Both cases: credentials supplied and wrong, and credentials needed and absent.

**A real iCloud account.** There is no substitute and no fixture that stands in
for one. Specifically: the partition-host hop, whether the credential has to be
re-attached across it, and whether Apple's `calendar-data` parses — HA carries
an open issue about Apple serving iCal content strict parsers reject, so a
hostile fixture copied from a real iCloud resource is the first thing to write,
before any of the transport.

**The host-confirmation policy, driven rather than reasoned about.** A
discovery chain that stays on one host must ask nothing — assert the add flow
completes with no extra step against a local server. A chain that moves must
stop, and the credential must not have been sent before it did: the assertion
is on what the *first* host received, which a test can only see by running a
server that records its own request headers. Then the stored answer: a second
sync goes straight to the confirmed host and asks nothing. Reverting the policy
must redden the middle one, and a test that only covers the happy path covers
the case that was never at risk.

**XXE, explicitly.** A `multistatus` response carrying a `DOCTYPE` with an
external entity, and a billion-laughs expansion. Both must be refused at the
document rather than parsed and ignored — §6.8's whole claim is that the
feature is absent, and a reader that tolerates `DOCTYPE` while declining to
expand it has the feature and a mitigation, which is the thing that gets
configured wrong later.

**The XML reader against something ugly.** Namespace prefixes vary by server
(`d:`/`D:`/`DAV:`), and a reader that works against Nextcloud's output and not
Apple's is the commonest way this goes wrong. Fixtures from both, byte for
byte, the way `packages/calendar/test/fixtures/real/` already does.

**Per-resource isolation, asserted.** §6.5 claims one malformed resource costs
one event. That is the first row of the bug table and it should be a test, with
a deliberately broken resource in the middle of a good response.

**The rotation case, which is what the schema decision was taken for.** A
CalDAV account with three calendars; change the password once; all three sync.
That assertion is the entire argument of §6.2.1, and under a flat scheme it
fails on two of the three — so it is the test that would have to be deleted
rather than adjusted if somebody later flattened the schema, which is the kind
of test worth having.

**`credentialFor` against both shapes**, as a unit, because it is one function
standing in for two storage locations and §6.2.2's whole claim is that no
caller knows the difference. A Phase A row, a Phase C row, a row with both (a
mistake, and it should prefer the account and say so), and a row with neither.

**The assumption in front of a real account, before the schema is written.**
§6.2.1 rests on households having more than one calendar per CalDAV account.
Open a real iCloud account and count. If it is reliably one, the parent table is
bought for nothing and this decision should be reopened — which is cheap to do
before Phase C and expensive afterwards.

**Recurrence parity across kinds.** The same weekly event, with a DST crossing
in the window, through ICS and through CalDAV, asserted to produce identical
rows. That is what §6.4's refusal of server expansion is for, and it is the
assertion that goes red if somebody later turns `<C:expand>` on as an
optimisation.

## 12. Open decisions

- **Whether two CalDAV accounts can share a server row.** §6.2.1 settles the
  account/calendar split and does not settle this: two adults' separate iCloud
  accounts are two credentials against one hostname, and two partition hosts.
  Two account rows is almost certainly right and costs nothing; it is listed so
  that nobody deduplicates by hostname later and merges two people's
  calendars.
- **CTag or `sync-collection` first.** §6.6. Measure against both providers.
- **How often.** ICS syncs on a schedule tuned for a cacheable document. A
  CalDAV CTag check is much cheaper than a full ICS fetch, so a CalDAV source
  could poll far more often and answer §2's complaint (2) properly. Worth
  measuring rather than inheriting the ICS interval by default.
- **Whether Phase B's copy names Home Assistant integrations.** Naming them is
  more useful and ages worse. Probably name them and accept the maintenance.
- **Google's staleness, quantified.** §7.2 proposes saying it on the screen.
  The sentence would be better with a number, and nobody here has measured one.

## 13. Non-goals

- **Writing to any calendar.** Every source in this product is read-only and
  that is not a gap. A wall that can create events is a different product with
  a keyboard in it.
- **Google OAuth, in any form.** §7, including the bring-your-own-client
  variant. Recorded as refused rather than deferred, so that reopening it
  requires an argument rather than a pull request.
- **CalDAV `sync-collection` in the first version.** §6.6.
- **Server-side recurrence expansion.** §6.4, and the parity test in §11 is
  what keeps it a non-goal.
- **CardDAV, tasks, or anything else DAV-shaped.** VTODO over CalDAV is a real
  thing and it is not this — RFC 012 covers to-do lists through Home Assistant,
  and a second to-do source would be a second credential and a second failure
  mode for the same widget.
- **A public-suffix list.** §6.3.1 rejects "same registrable domain" as the
  discovery policy, and the reason is the list rather than the idea: a real one
  is a dependency plus a data file that rots, and the two-label approximation is
  silently wrong for `.co.uk` households in the direction that leaks the
  password.
- **A general XML parser.** §6.8. Not a rule about dependencies — a rule about
  this one, where the narrow reader is the safer artefact rather than merely
  the smaller one.
- **Auto-discovery by email address.** RFC 6764's SRV/TXT bootstrapping would
  let somebody type `me@fastmail.com` and find the server. It is genuinely nice
  and it needs DNS SRV lookups from inside the SSRF-guarded boundary, which is
  a third widening of the thing §6.3 is already widening twice. Not now.

## Appendix A — the provider matrix

| Provider | Works today | Phase A | Phase C | Via Home Assistant |
|---|---|---|---|---|
| Google | secret ICS (stale) | — | — | ✓ (HA does OAuth) |
| Apple iCloud | public share ICS — **unauthenticated**, and delayed | — | ✓ CalDAV + app password | ✓ (HA caldav) |
| Nextcloud | LAN opt-in, no auth | ✓ `?export` + app password | ✓ | ✓ |
| Microsoft 365 | published ICS | ✓ | ✓ CalDAV | ✓ |
| Fastmail | — | ✓ | ✓ | ✓ |
| Baïkal, Radicale, SOGo | if unauthenticated | ✓ | ✓ | ✓ |
| School / council feeds | ✓ | ✓ if behind Basic | — | ✓ |
| Proton | — | — | — | ✓ via Bridge |

The column that matters is the last one, and it is the one nothing in the
product mentions. That is Phase B, and it is the cheapest row in this document.

The column to read next is the first, and iCloud's entry is why Phase C is
committed rather than costed: a public iCloud share link is readable by anybody
holding the URL, so "works today" there means a household publishing their
family's calendar to the internet.
