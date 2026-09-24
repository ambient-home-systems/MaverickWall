# Bundled emoji artwork

These SVGs ship inside the image and are served same-origin at
`/assets/emoji/<key>.svg` (rule three: nothing is fetched from a third party
at runtime). They exist because the image ships no emoji font — without them,
an emoji set as *text* is resolved by whichever font the household's tablet
happens to carry, which differs by device and is sometimes empty (see
`apps/display/src/emoji.ts` and decision D6, 2026-09-24).

A curated subset of 155 of the roughly 3,700 pictures in Twemoji, drawn from
one hand rather than assembled from several: each covers a weather condition,
a countdown occasion (Christmas, a birthday, Halloween, a vacation, school's
out, New Year), an advice line (umbrella, coat, shorts, sunscreen, wind), a
general countdown picker, or the Store's own hourglass mark. The file names
are the kebab-case **keys** `apps/display/src/emoji.ts` and
`apps/server/src/emoji.ts` both name — never the emoji's own code point, which
is the whole point of keying it (rule three again, one layer down: a code
point handed to the device's own font in a designed style is the bug this
artwork exists to remove).

## Twemoji

| Source | Licence | Copyright |
|---|---|---|
| [Twemoji](https://github.com/jdecked/twemoji) (the `jdecked/twemoji` fork, maintained after Twitter/X archived the original project) | CC-BY 4.0 (graphics only — Twemoji's own code is MIT and none of it is used here) | © Twitter, Inc and other contributors |

Full licence text: https://creativecommons.org/licenses/by/4.0/

Twemoji's own attribution guidance (README, "Attribution Requirements") calls
a mention in the project's source sufficient, and this file is that mention.
Every SVG here is used unmodified except for the file name, which is the
kebab-case key above rather than Twemoji's own hex-codepoint name (for
example `2600.svg` is `sun.svg`) — a rename, not an edit to the artwork.

## Not included

Twemoji ships flags, skin-tone variants and multi-person family sequences.
None of those are curated here: a flag is a stranger's set of household facts
this product has no business drawing, and a skin-tone or gender variant would
need one household setting per emoji to pick correctly rather than never being
asked. The 155 keys in this set are single-codepoint, default-presentation
pictures only.
