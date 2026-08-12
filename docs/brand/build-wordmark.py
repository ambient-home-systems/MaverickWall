"""
Builds the wordmark and the lockups from a real typeface.

The letters are outlined to paths at build time, so the committed SVG needs no
font installed anywhere and cannot silently fall back to Arial — but the shapes
are a professional's, not ours. An earlier version of this file drew the
alphabet by hand and went through three rounds of "that looks cut off"; a
display face is not a thing to draw on the way to something else.

The faces are the ones already bundled in apps/server/assets/fonts for the
display themes, so the wordmark adds no new file, no new licence and no new
download. Their licences are recorded beside them in LICENSES.md.

    pip install fonttools brotli
    python3 docs/brand/build-wordmark.py

Output is committed. Nothing in the build or the image runs this.
"""

from pathlib import Path

from fontTools.misc.transform import Transform
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "apps/server/assets/fonts"
OUT = Path(__file__).resolve().parent

CAP = 64.0  # the marks' grid, so a lockup is one coordinate system

ACCENT = "var(--mw-accent, #E8A33D)"
NEUTRAL = "var(--mw-neutral, #6B7684)"
INK = "var(--mw-ink, #E9EEF4)"


def load(name, weight=None):
    font = TTFont(FONTS / name)
    if weight is not None and "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": weight})
    return font


def typeset(font, text, tracking=0.0):
    """Outline `text` with the baseline at y=CAP and the cap line at y=0."""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm
    cap_height = getattr(font["OS/2"], "sCapHeight", 0) or font["OS/2"].sTypoAscender
    scale = CAP / cap_height

    paths = []
    x = 0.0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f"no glyph for {ch!r}")
        glyph = glyphs[name]
        pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}")
        # Fonts are y-up from the baseline; SVG is y-down from the cap line.
        glyph.draw(TransformPen(pen, Transform(scale, 0, 0, -scale, x, CAP)))
        d = pen.getCommands()
        if d:
            paths.append(f'<path d="{d}"/>')
        x += glyph.width * scale + tracking
    return {"width": round(x - tracking, 2), "body": "".join(paths)}


# The mark, in the same units, so a lockup is one coordinate system.
def mark_markup():
    cells = []
    for row in range(5):
        for col in range(7):
            cx, cy = 8 + col * 7, 15 + row * 7
            if (col, row) == (3, 2):
                continue
            cells.append(f'<rect x="{cx}" y="{cy}" width="6" height="6" rx="1"/>')
    return (
        f'\n    <g fill="{NEUTRAL}" fill-opacity=".34">' + "".join(cells) + "</g>"
        f'\n    <rect x="29" y="29" width="6" height="6" rx="1" fill="{ACCENT}"/>'
    )


MARK = mark_markup()
INK_X, INK_Y, INK_W, INK_H = 8, 15, 48, 34


def svg(width, height, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="Maverick Wall">\n'
        f"{body}\n</svg>\n"
    )


def lockup(cap, lines, lead):
    """
    Bound to the mark's INK box, not its padded icon box, and the mark scaled so
    its ink height equals the cap height. Dropped in at its icon size the grid
    reads a size smaller than the type beside it.
    """
    k = (cap * len(lines) + lead * (len(lines) - 1)) / INK_H
    s = cap / CAP
    x = INK_W * k + round(cap * 0.55)
    height = INK_H * k
    width = round(x + max(l["width"] for l in lines) * s)
    text = "\n    ".join(
        f'<g transform="translate({x:.2f} {i * (cap + lead):.2f}) '
        f'scale({s:.5f})">{l["body"]}</g>'
        for i, l in enumerate(lines)
    )
    body = (
        f'  <g transform="scale({k:.5f}) translate({-INK_X} {-INK_Y})">{MARK}\n  </g>\n'
        f'  <g fill="{INK}">\n    {text}\n  </g>'
    )
    return svg(width, round(height, 2), body)


def build(font_file, weight, tracking, label):
    font = load(font_file, weight)
    line = typeset(font, "MAVERICK WALL", tracking)
    mav = typeset(font, "MAVERICK", tracking)
    wal = typeset(font, "WALL", tracking)

    (OUT / "wordmark").mkdir(exist_ok=True)
    (OUT / "wordmark/wordmark.svg").write_text(
        svg(line["width"], CAP,
            f'  <!-- {label}, outlined: no font has to be installed anywhere. -->\n'
            f'  <g fill="{INK}">{line["body"]}</g>')
    )
    (OUT / "wordmark/lockup-horizontal.svg").write_text(lockup(44, [line], 0))
    (OUT / "wordmark/lockup-stacked.svg").write_text(lockup(26, [mav, wal], 8))
    print(f"{label}: wordmark {line['width']}, maverick {mav['width']}")


if __name__ == "__main__":
    # Oswald 700. Condensed, and the only face here drawn for signage rather
    # than for paragraphs, which is what a name on a wall is.
    build("oswald-700.woff2", None, 1.0, "Oswald 700")
