import sys, numpy as np
from PIL import Image
from fontTools.ttLib import TTFont
SHOT, FONT, OX, OY = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
f = TTFont(FONT); glyf = f['glyf']; L = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; cm = f.getBestCmap()
order = f.getGlyphOrder()
U = 32; H = 32
def cells_of(name):
    g = glyf[name]; cells = set()
    if g.numberOfContours > 0:
        c = g.coordinates; st = 0
        for e in g.endPtsOfContours:
            pts = list(c[st:e+1]); st = e + 1
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            for y in range(H - max(ys)//U, H - min(ys)//U):
                for x in range(min(xs)//U, max(xs)//U):
                    cells.add((x, y))
    return frozenset(cells)
layer_glyphs = {}
for base, lays in L.items():
    for lay in lays:
        layer_glyphs[lay.name] = (cells_of(lay.name), lay.colorID, base)
shot = np.asarray(Image.open(SHOT).convert('RGB')).astype(int)
grid = shot[OY:OY+64:2, OX:OX+160:2]
opaque = {i: (p.red, p.green, p.blue) for i, p in enumerate(pal) if p.alpha == 255}
found = {}
for y in range(32):
    for x in range(80):
        px = grid[y, x]
        for i, c in opaque.items():
            if abs(px[0]-c[0]) + abs(px[1]-c[1]) + abs(px[2]-c[2]) <= 3:
                found.setdefault(i, set()).add((x, y)); break
print('colours on screen', len(found))
for i, cs in sorted(found.items(), key=lambda kv: -len(kv[1]))[:10]:
    best = max(((len(cs & g) / len(cs | g), n, base) for n, (g, ci, base) in layer_glyphs.items() if ci == i), default=None)
    bestany = max(((len(cs & g) / len(cs | g), n, ci) for n, (g, ci, base) in layer_glyphs.items()))
    print(f'pal {i:3d} {opaque[i]} screen cells {len(cs):3d}  best same-colour glyph {best[1]} J={best[0]:.2f}   best any glyph {bestany[1]} (pal {bestany[2]}) J={bestany[0]:.2f}  gid {order.index(bestany[1])}')
