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

## The 3D set: Fluent Emoji

Meteocons draws its pictures in four styles (fill, flat, line and monochrome),
and none of them is 3D. So the 3D set, under `3d/`, is Microsoft's Fluent
Emoji instead: the 3D renders, 256x256 PNGs, copied unedited from
[microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji) at
commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`. Each file
is renamed from `assets/<Name>/3D/<name>_3d.png` to its name in kebab case,
which is the name `fluent3dFor` in `apps/display/src/weather-icons.ts` asks
for. `meteocons.test.ts` holds every file to the sha256 written here.

| File | Upstream | sha256 |
|---|---|---|
| `3d/cloud-with-lightning-and-rain.png` | `assets/Cloud with lightning and rain/3D/cloud_with_lightning_and_rain_3d.png` | `ed1f207db4824e666055faba6461900d24300332926d72379a53f7d904a2cfbe` |
| `3d/cloud-with-rain.png` | `assets/Cloud with rain/3D/cloud_with_rain_3d.png` | `75dd1e6fc5f6b92cbc222ab0b9c10e60f889af2b82453ba784ba0517ffd690b4` |
| `3d/cloud-with-snow.png` | `assets/Cloud with snow/3D/cloud_with_snow_3d.png` | `24d8b8eaf2123f475b7ca32f8dbb702cb26418621c1c1dab7c3a56fa6506e4fd` |
| `3d/cloud.png` | `assets/Cloud/3D/cloud_3d.png` | `a4d4629711661a80f6b6b0081c0f84e65352518b2bf23f4c1bec55e297a9fafc` |
| `3d/first-quarter-moon.png` | `assets/First quarter moon/3D/first_quarter_moon_3d.png` | `e5fd47d4be3f2b614897eb1d379675569bf5b4e45574f4558357d76b0a72a22b` |
| `3d/fog.png` | `assets/Fog/3D/fog_3d.png` | `445768dba68aabcaf7c5cc825099272fec1fe0550db9d991d6e4be300eb643b0` |
| `3d/full-moon.png` | `assets/Full moon/3D/full_moon_3d.png` | `00dd24efe4fc9b13a020f59309d962ecd3bede581abeca5111056a8fc84c779e` |
| `3d/last-quarter-moon.png` | `assets/Last quarter moon/3D/last_quarter_moon_3d.png` | `4d5a07f28be60a408219631b1c8ffa2869793b355d9aa888fbebb189f488a5a4` |
| `3d/leaf-fluttering-in-wind.png` | `assets/Leaf fluttering in wind/3D/leaf_fluttering_in_wind_3d.png` | `5a7dfcacc94c57166dc2d7b0e7517981a35fcc6ed231eafa6719aee642c1d166` |
| `3d/new-moon.png` | `assets/New moon/3D/new_moon_3d.png` | `d035da009afcc21b93aab54728bdebc018edd524220075d22ec9ab1f7a57d1bc` |
| `3d/sun-behind-cloud.png` | `assets/Sun behind cloud/3D/sun_behind_cloud_3d.png` | `d4972a180706ee21ad82b903c394c2eae536b72ddd78e80599cbb790570f2c58` |
| `3d/sun-behind-rain-cloud.png` | `assets/Sun behind rain cloud/3D/sun_behind_rain_cloud_3d.png` | `4e9aaa34703f42dcde99a32eef923ab0fa196d250260339259477a7c045ba03e` |
| `3d/sun-behind-small-cloud.png` | `assets/Sun behind small cloud/3D/sun_behind_small_cloud_3d.png` | `f39945a2f4b042b7d12ad67462e9bb1b6954c80f79d9b08f3c38d7bfbbb6522e` |
| `3d/sun.png` | `assets/Sun/3D/sun_3d.png` | `c9bb15d03d4b1e6151d97e12119ac93bbd2bcb5e713a49c1fcfc11ece54caec1` |
| `3d/waning-crescent-moon.png` | `assets/Waning crescent moon/3D/waning_crescent_moon_3d.png` | `9054f9b379d58d8a88fd4a9fe38324ca041773c35f8066d7bb067be3a16dccaf` |
| `3d/waning-gibbous-moon.png` | `assets/Waning gibbous moon/3D/waning_gibbous_moon_3d.png` | `ab852de2cb4fa0dc7575fe14184adabad9db21be10a99f7b6cef6b3087514583` |
| `3d/waxing-crescent-moon.png` | `assets/Waxing crescent moon/3D/waxing_crescent_moon_3d.png` | `51bde6d57cc91954e10ee42bc223f661b5d7323b9d507c63ae8dc02dffd999bd` |
| `3d/waxing-gibbous-moon.png` | `assets/Waxing gibbous moon/3D/waxing_gibbous_moon_3d.png` | `4723a54f69a2d9de27793d97270e34546bf5071fe7bfab5b349af123379f980d` |

| Source | Licence | Copyright |
|---|---|---|
| [Fluent Emoji](https://github.com/microsoft/fluentui-emoji), the 3D renders | MIT | © Microsoft Corporation |

```
MIT License

Copyright (c) Microsoft Corporation.

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
SOFTWARE
```
