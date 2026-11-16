"""Build a COLRv0 color font whose glyphs are pixel-art frames.

Each frame is drawn on a W x H art grid; every color is one layer glyph made of merged rectangles.
The font's em is the grid height, so at text_size = H * scale each art pixel is `scale` px.
"""
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL

U = 32  # font units per art pixel


def rects_glyph(cells, H):
    """cells: iterable of (x, y), y = 0 at the top. Horizontal runs merged, then identical runs merged down."""
    rows = {}
    for x, y in cells:
        rows.setdefault(y, []).append(x)
    runs_by_row = {}
    for y, xs in rows.items():
        xs = sorted(set(xs))
        runs, start, prev = [], xs[0], xs[0]
        for x in xs[1:]:
            if x == prev + 1:
                prev = x
                continue
            runs.append((start, prev))
            start = prev = x
        runs.append((start, prev))
        runs_by_row[y] = runs
    # vertical merge of identical runs
    rects = []
    open_ = {}  # run -> (y_start)
    for y in range(0, H + 1):
        cur = set(runs_by_row.get(y, []))
        for run in list(open_):
            if run not in cur:
                rects.append((run[0], open_[run], run[1], y - 1))
                del open_[run]
        for run in cur:
            if run not in open_:
                open_[run] = y
    pen = TTGlyphPen(None)
    for x0, y0, x1, y1 in rects:
        X0, X1 = x0 * U, (x1 + 1) * U
        Y1, Y0 = (H - y0) * U, (H - y1 - 1) * U
        pen.moveTo((X0, Y0))
        pen.lineTo((X0, Y1))
        pen.lineTo((X1, Y1))
        pen.lineTo((X1, Y0))
        pen.closePath()
    return pen.glyph()


def build(path, family, frames, palette, W, H, first=0xE000):
    """frames: list of dict {palette_index: set of (x, y)}; codepoints first, first+1, ..."""
    UPM = H * U
    names = ['.notdef', 'space']
    glyphs = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}
    cmap = {0x20: 'space'}
    layers = {}
    for i, fr in enumerate(frames):
        base = f'f{i}'
        names.append(base)
        cmap[first + i] = base
        lay = []
        for ci, cells in sorted(fr.items()):
            if not cells:
                continue
            ln = f'f{i}c{ci}'
            glyphs[ln] = rects_glyph(cells, H)
            names.append(ln)
            lay.append((ln, ci))
        # base glyph: union of all layers (used where color is not supported)
        allc = set().union(*[c for c in fr.values()]) if fr else set()
        glyphs[base] = rects_glyph(allc, H) if allc else TTGlyphPen(None).glyph()
        layers[base] = lay
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    adv = W * U
    glyf = fb.font['glyf']
    for n in names:
        glyf[n].recalcBounds(glyf)
    # lsb = xMin, or Windows shifts each colour layer by its own xMin and the layers stop lining up
    fb.setupHorizontalMetrics({n: (adv, getattr(glyf[n], 'xMin', 0) if glyf[n].numberOfContours else 0) for n in names})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + '-Regular', 'fullName': family + ' Regular', 'psName': family.replace(' ', '') + '-Regular', 'version': 'Version 1.000'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0,
                fsType=0)
    fb.setupPost()
    fb.font['COLR'] = buildCOLR(layers)
    fb.font['CPAL'] = buildCPAL([[tuple(c / 255 for c in col[:3]) + ((col[3] / 255) if len(col) > 3 else 1.0,) for col in palette]])
    fb.save(path)


if __name__ == '__main__':
    pal = [(255, 0, 0), (0, 200, 0), (40, 80, 255), (255, 220, 0), (20, 20, 20)]
    frames = []
    for k in range(4):
        fr = {4: {(x, y) for x in range(4, 28) for y in range(4, 28) if x in (4, 27) or y in (4, 27)},
              k: {(x, y) for x in range(5 + k * 2, 27) for y in range(5, 27)}}
        frames.append(fr)
    build(sys.argv[1], 'PixelTestColor', frames, pal, 32, 32)

