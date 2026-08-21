# Bundled fonts

These fonts ship inside the image and are served same-origin (rule three: nothing
is fetched from a third party at runtime). Each is redistributable under an open
licence. The `latin` subset is used, taken from Google Fonts.

| File | Family | Licence | Copyright / source |
|------|--------|---------|--------------------|
| `inter-400.woff2`, `inter-700.woff2` | Inter | SIL Open Font License 1.1 | © The Inter Project Authors — https://github.com/rsms/inter |
| `oswald-400.woff2`, `oswald-700.woff2` | Oswald | SIL Open Font License 1.1 | © The Oswald Project Authors — https://github.com/googlefonts/OswaldFont |
| `fraunces-400.woff2`, `fraunces-700.woff2` | Fraunces | SIL Open Font License 1.1 | © The Fraunces Project Authors — https://github.com/undercasetype/Fraunces |
| `jetbrains-mono-400.woff2`, `jetbrains-mono-700.woff2` | JetBrains Mono | SIL Open Font License 1.1 | © The JetBrains Mono Project Authors — https://github.com/JetBrains/JetBrainsMono |
| `space-grotesk-400.woff2`, `space-grotesk-700.woff2` | Space Grotesk | SIL Open Font License 1.1 | © The Space Grotesk Project Authors — https://github.com/floriankarsten/space-grotesk |
| `roboto-condensed.woff2` | Roboto Condensed | Apache License 2.0 | © Google — https://github.com/googlefonts/roboto |
| `roboto.woff2` | Roboto | Apache License 2.0 | © Google — https://github.com/googlefonts/roboto |

`roboto.woff2` is the variable font (weight axis 100–900, so it carries the
400/500/700 the admin's Material Design 3 type scale uses in one file, the same
way `roboto-condensed.woff2` does).

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
