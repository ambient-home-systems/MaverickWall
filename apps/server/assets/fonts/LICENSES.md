# Bundled fonts

These fonts ship inside the image and are served same-origin (rule three: nothing
is fetched from a third party at runtime). Each is redistributable under an open
licence. The `latin` subset is used, taken from Google Fonts.

| File | Family | Licence | Copyright / source |
|------|--------|---------|--------------------|
| `oswald-400.woff2`, `oswald-700.woff2` | Oswald | SIL Open Font License 1.1 | © The Oswald Project Authors — https://github.com/googlefonts/OswaldFont |
| `fraunces-400.woff2`, `fraunces-700.woff2` | Fraunces | SIL Open Font License 1.1 | © The Fraunces Project Authors — https://github.com/undercasetype/Fraunces |
| `space-grotesk-400.woff2`, `space-grotesk-700.woff2` | Space Grotesk | SIL Open Font License 1.1 | © The Space Grotesk Project Authors — https://github.com/floriankarsten/space-grotesk |
| `roboto-flex.woff2` | Roboto Flex | SIL Open Font License 1.1 | © The Roboto Flex Project Authors — https://github.com/TypeNetwork/Roboto-Flex |
| `roboto-condensed.woff2` | Roboto Condensed | Apache License 2.0 | © Google — https://github.com/googlefonts/roboto |
| `roboto.woff2` | Roboto | Apache License 2.0 | © Google — https://github.com/googlefonts/roboto |

`roboto.woff2` is the variable font (weight axis 100–900, so it carries the
400/500/700 the admin's Material Design 3 type scale uses in one file, the same
way `roboto-condensed.woff2` does).

`roboto-flex.woff2` is also a variable font, restricted to three axes and a
single weight (see `display.css`'s own comment at the `@font-face` rule for
why): `wdth` 75–100 (the wall's condensed cut is this face at a width, not a
second family), `opsz` 8–144 (driven automatically by `font-optical-sizing:
auto`, the default, from each element's own `font-size`), and `GRAD` -50..100
(exposed as `--f-grade`, for a future stroke correction that costs no reflow).
It embeds its own OFL notice (`https://scripts.sil.org/OFL`) despite sharing
the Roboto superfamily's design lineage with the two Apache-2.0 faces above —
Roboto Flex was designed by Font Bureau/Type Network for Google under a
separate licence from the original Roboto release, and the file's own name
table is the source of truth used here, not an assumption from the family
name.

Every bundled face not otherwise reserved is subset to the same cut: Basic
Latin plus the Latin-1 Supplement block, plus the handful of general
punctuation marks (smart quotes, dashes, an ellipsis) a household's own text
actually uses — Google Fonts' own "latin" cut, which is why the codepoints in
each file go a little past `U+00FF`.

## SIL Open Font License, Version 1.1

The OFL fonts above are used under the SIL Open Font License 1.1. Full text:
https://openfontlicense.org/open-font-license-official-text/

Summary of the terms honoured here: the fonts may be bundled and redistributed
with this software, are not sold on their own, retain their reserved names, and
carry this notice. The Apache-2.0 fonts (Roboto, Roboto Condensed) are used
under https://www.apache.org/licenses/LICENSE-2.0.

## Material Symbols

The admin's inline icons are Material Symbols Outlined (24dp, default weight),
© Google, Apache License 2.0 — https://github.com/google/material-design-icons.
No font file ships: the glyph outline paths are copied into `ICON_PATHS` in
`apps/server/src/http/html.ts` (rule three — nothing is fetched at runtime),
each entry named after its Symbols source glyph.
