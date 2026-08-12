# Brand

Five candidate marks and a wordmark for Maverick Wall. **Nothing here is in use
yet** — `addon/maverick-wall/icon.png` is still the shipped tile, and swapping
it is a deliberate step, not something that should happen by a file landing in
this directory.

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
licence to track, and it cannot silently fall back to Arial. Condensed
geometric caps on the same 64-unit grid as the marks, 11-unit stems, and every
curve cut at 45° instead — one decision, applied to the C and the R, which is
what keeps it reading as a cut rather than as failed curves.

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

## If one of these is adopted

Four places carry the identity, and they have to move together or the product
looks like two products:

1. `addon/maverick-wall/icon.png` — 512×512
2. `addon/maverick-wall/logo.png` — 1000×300, and the one in the repository
   today is nearly blank, which is worth fixing whichever mark wins
3. the favicon on the admin screens and the wizard
4. the README

Check the result signed out, with `curl`, not in a logged-in tab — the same
trap that hid the add-on repository being private.
