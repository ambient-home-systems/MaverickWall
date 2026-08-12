# Brand

Five candidate marks and a wordmark for Maverick Wall.

**03, Lit Cell, is the one in use.** It is on the add-on tile, the add-on logo,
the admin and wizard screens, and the wall's own browser tab. The other four
stay here because the reasoning is worth keeping — a mark is easier to defend
against the ones that were not chosen.

Open `logo-options.html` in a browser for the pitch: every mark on both shipped
themes, in monochrome, and at 40/32/24/16 px, with what each one is good at and
where it falls over.

## The set

| | Mark | Draws |
|---|---|---|
| 01 | `marks/panel.svg` | the hardware — a portrait screen, lit |
| 02 | `marks/seven.svg` | a week — seven strokes, one of them today |
| 03 | `marks/lit-cell.svg` | the idea — a quiet month, one cell lit |
| 04 | `marks/out-of-line.svg` | the name — one cell steps out of rank |
| 05 | `marks/corner.svg` | nothing — two shapes, the wall and today |

Ordered literal to abstract. **03 is the recommendation**, 05 the alternate.

`marks/lit-cell-small.svg` is a redraw of 03 with five columns instead of
seven, for anything below about 20 px. It is a different file on purpose: at
favicon size a 7×5 field is texture, not a grid. Use it for the favicon and
nothing else.

## Colour

Every file takes its colours from three custom properties, with the Board
values as fallbacks — so an inline SVG follows whatever theme surrounds it, and
a file loaded through `<img>` (where custom properties do not inherit) still
comes out right on a dark ground.

| Property | Board (dark) | Almanac (paper) |
|---|---|---|
| `--mw-neutral` | `#6B7684` | `#6B6558` |
| `--mw-accent` | `#E8A33D` | `#C98A16` |
| `--mw-ink` | `#E9EEF4` | `#1A1815` |

**On a light ground you must set all three.** Board's amber has too little
contrast on paper — it is a colour chosen to glow on near-black in a dark
kitchen, and it goes muddy the moment there is white behind it.

The values come from `apps/display/src/theme.ts`, which stays the source of
truth. If a theme token changes there, these change with it.

## The wordmark

`wordmark/wordmark.svg` is **drawn, not set**: every glyph is an outlined path,
so it renders identically on a machine with no fonts installed, there is no
licence to track, and it cannot silently fall back to Arial. Geometric caps on
the same 64-unit grid as the marks, with 11-unit stems, true circular bowls on
the C and the R, and real points on the A, V, W and M.

The first cut of this alphabet chamfered every curve at 45° and cut the apexes
flat, on the theory that one decision applied everywhere would read as a
deliberate style. It did not: it read as a typeface with its curves sliced off
— "cropped or cut off" was the verdict, and it was right. Curves are curves
here now, and the only flat cuts left are the C's terminals, where a stroke
genuinely ends in the open and the vertical cut is the geometric convention.

Edit `build-wordmark.mjs` and re-run it rather than editing the path data:

```bash
node docs/brand/build-wordmark.mjs
```

The glyphs, the tracking and the kern pairs are all readable in that file. The
output is committed; nothing in the build or the image runs it.

Two lockups, both with the mark scaled so its **ink** height matches the cap
height. Dropped in at its icon size the grid reads a size smaller than the type
beside it, which is the commonest way a lockup goes subtly wrong.

- `wordmark/lockup-horizontal.svg` — mark, then the name on one line
- `wordmark/lockup-stacked.svg` — mark, then two lines

## App icons

`app-icon/lit-cell-512.svg` and `app-icon/corner-512.svg` are the add-on tiles:
the mark on the Board theme's own ground and rule, so the icon and the wall it
configures are visibly the same product. 512×512 with a 112 corner radius,
which is what Home Assistant's own tiles use.

Home Assistant wants PNG. There is no rasteriser in this repo, so convert with
whatever is to hand — a headless browser screenshot of the SVG at 512 works and
needs nothing installed.

## Where it is used

Four places carry the identity, and they have to move together or it looks like
two products:

1. `addon/maverick-wall/icon.png` — 512x512, transparent corners
2. `addon/maverick-wall/logo.png` — 1000x300, the horizontal lockup on Board.
   The file this replaced was nearly blank: a dark bar across the top of white
3. `apps/server/src/http/html.ts` — the `MARK` constant, which is the admin
   sidebar, the wizard, and the data-URI favicon
4. `apps/display/src/index.html` — the wall's own tab icon, inline

**Both of the small ones use the five-column redraw**, and its dim cells are
lifted to `#363D45` rather than the `#6B7684` at 34% the large mark uses. At
34px the darker grey vanished and the mark read as a black square with an
orange dot — found by rendering the wizard and looking at it, which is the only
way that kind of fault ever shows up.

## Making the PNGs

There is no rasteriser in this repository and none is being added for two
images. They were made with the Chromium already present for the browser tests:

```bash
chrome --headless --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 \
  --window-size=512,599 --screenshot=raw.png file://.../icon.html
python3 docs/brand/crop-png.py raw.png icon.png 512 512
```

The window is 87px taller than the image on purpose: headless Chrome
screenshots the whole window, and the viewport is shorter than the window it
was asked for, so the first attempt came out with the bottom of the icon sliced
off. `crop-png.py` trims it back to size.

Check the result signed out, with `curl`, not in a logged-in tab — the same
trap that hid the add-on repository being private.
