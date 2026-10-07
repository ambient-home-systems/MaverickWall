# Bundled Meteocons pictures

These SVGs ship inside the image and are served same-origin at
`/assets/meteocons/<set>/<name>.svg` (rule three: nothing is fetched from a
third party at runtime). They are the forecast widget's second picture set
(plan item M5.9), chosen with **Pictures** in the widget's settings: `fill`
is "Colour" and `line` is "Outline".

Twenty-four of each, one for every sky the wall's glyph vocabulary names, by
day and by night, and the moon in eight phases for a clear night. Which file
a sky wears is `meteoconFor` in `apps/display/src/weather-icons.ts`.

**The static set, never the animated one.** Meteocons ships each picture
twice; the animated files move by SVG's own `<animate>`, which nothing on a
wall could scope to reduced motion or to a wall's Motion switch (decision
MQ7). These are `@meteocons/svg-static` 0.1.0, copied unedited, and
`meteocons.test.ts` holds every one to carrying no animation, no `<style>`,
no script and no reference outside itself. What moves a picture is
`display.css`'s scoped block, locked to the wall clock by `motion.ts`.

## Meteocons

| Source | Licence | Copyright |
|---|---|---|
| [Meteocons](https://github.com/basmilius/weather-icons), `@meteocons/svg-static` 0.1.0 from the npm registry | MIT | © 2020-present Bas Milius |

```
MIT License

Copyright (c) 2020-present Bas Milius

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
