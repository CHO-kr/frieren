import sys, numpy as np
sys.path.insert(0, sys.argv[1])
import anim
from fontTools.ttLib import TTFont
S = sys.argv[1]; FONT = sys.argv[2]
f = TTFont(FONT); glyf = f['glyf']; L = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; cm = f.getBestCmap()
poses, anchors = anim.load('himmel', S + r'\..\spr' if False else sys.argv[3])
an = anim.animations('himmel', poses, anchors)
U = 32; H = 32
def font_cells(cp):
    out = {}
    for lay in L[cm[cp]]:
        g = glyf[lay.name]; cells = set()
        if g.numberOfContours > 0:
            c = g.coordinates; st = 0
            for e in g.endPtsOfContours:
                pts = list(c[st:e+1]); st = e + 1
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                for y in range(H - max(ys)//U, H - min(ys)//U):
                    for x in range(min(xs)//U, max(xs)//U):
                        cells.add((x, y))
        out[lay.colorID] = cells
    return out
ms, fl = an['cast']
fr = fl[3](80)
fc = font_cells(0xE00D)
allf = set().union(*fc.values())
op = {(int(x), int(y)) for y, x in zip(*np.nonzero(fr[..., 3] > 0))}
print('frame px', len(op), 'font cells', len(allf), 'missing', len(op - allf), 'extra', len(allf - op))
bad = 0
for ci, cs in fc.items():
    c = pal[ci]
    for (x, y) in cs:
        px = fr[y, x]
        if abs(int(px[0]) - c.red) + abs(int(px[1]) - c.green) + abs(int(px[2]) - c.blue) > 6: bad += 1
print('wrong colour cells', bad)
# overlapping layers?
seen = {}
ov = 0
for ci, cs in fc.items():
    for p in cs:
        if p in seen: ov += 1
        seen[p] = ci
print('cells in >1 layer', ov)
# alpha of frame pixels
al = fr[..., 3][fr[..., 3] > 0]
print('alpha hist', np.unique(al, return_counts=True))
