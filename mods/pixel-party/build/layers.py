import sys, numpy as np
from PIL import Image
from fontTools.ttLib import TTFont
SHOT, FONT = sys.argv[1], sys.argv[2]
f = TTFont(FONT); glyf = f['glyf']; L = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; cm = f.getBestCmap()
U = 32; H = 32
def font_layers(cp):
    out = []
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
        out.append((lay.colorID, lay.name, cells))
    return out
shot = np.asarray(Image.open(SHOT).convert('RGB')).astype(int)
best = None
cache = {cp: font_layers(cp) for cp in range(0xE000, 0xE03C) if cp in cm}
for cp, lays in cache.items():
    for oy in range(66, 90, 2):
        for ox in range(300, 320, 2):
            sc = 0; n = 0
            for ci, nm, cs in lays:
                c = pal[ci]
                if c.alpha < 250: continue
                for (x, y) in cs:
                    px = shot[oy + 2*y, ox + 2*x]; n += 1
                    sc += (abs(px[0]-c.red)+abs(px[1]-c.green)+abs(px[2]-c.blue)) < 12
            if n and (best is None or sc/n > best[0]): best = (sc/n, cp, ox, oy)
print('best', best)
_, cp, ox, oy = best
for i, (ci, nm, cs) in enumerate(cache[cp]):
    c = pal[ci]
    ok = sum((abs(shot[oy+2*y, ox+2*x][0]-c.red)+abs(shot[oy+2*y, ox+2*x][1]-c.green)+abs(shot[oy+2*y, ox+2*x][2]-c.blue)) < 12 for (x, y) in cs)
    print(f'layer {i:2d} pal {ci:3d} rgba ({c.red:3d},{c.green:3d},{c.blue:3d},{c.alpha:3d}) cells {len(cs):3d} drawn {ok:3d}')
