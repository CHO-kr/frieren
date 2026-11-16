import sys, numpy as np
from PIL import Image
from fontTools.ttLib import TTFont
S = sys.argv[1]; FONT = sys.argv[2]
f = TTFont(FONT); colr = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; gs = f.getGlyphSet(); cmap = f.getBestCmap()
from fontTools.pens.recordingPen import RecordingPen
def raster(cp, W=80, H=32, U=32):
    img = np.zeros((H, W, 4), float)
    for lay in colr[cmap[cp]]:
        rp = RecordingPen(); gs[lay.name].draw(rp)
        c = pal[lay.colorID]; col = np.array([c.red, c.green, c.blue, c.alpha], float)
        pts = []
        for op, args in rp.value:
            if op == 'moveTo': pts = [args[0]]
            elif op == 'lineTo': pts.append(args[0])
            elif op == 'closePath':
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                x0, x1 = min(xs)//U, max(xs)//U; y0, y1 = H - max(ys)//U, H - min(ys)//U
                for y in range(int(y0), int(y1)):
                    for x in range(int(x0), int(x1)):
                        a = col[3]/255; img[y, x, :3] = col[:3]*a + img[y, x, :3]*(1-a); img[y, x, 3] = max(img[y, x, 3], col[3])
    return img
shot = np.asarray(Image.open(f'{S}/seq0.png').convert('RGB')).astype(int)
# stage glyph top-left guess: search offsets that best match frame candidates
best = None
for cp in range(0xE00A, 0xE016):
    fr = raster(cp)
    m = fr[..., 3] > 250
    for oy in range(56, 100, 1):
        for ox in range(300, 330, 1):
            sub = shot[oy:oy+64:2, ox:ox+160:2]
            if sub.shape[:2] != (32, 80): continue
            d = np.abs(sub - fr[..., :3]).sum(2)[m]
            sc = (d < 40).mean()
            if best is None or sc > best[0]: best = (sc, cp, ox, oy)
print('best match', best)
sc, cp, ox, oy = best
fr = raster(cp); sub = shot[oy:oy+64:2, ox:ox+160:2]
m = fr[..., 3] > 250
bad = m & (np.abs(sub - fr[..., :3]).sum(2) > 60)
print('opaque px', m.sum(), 'mismatched', bad.sum())
cols = {}
for y, x in zip(*np.nonzero(bad)): cols[tuple(fr[y, x, :3].astype(int))] = cols.get(tuple(fr[y, x, :3].astype(int)), 0) + 1
print('missing colours', sorted(cols.items(), key=lambda kv: -kv[1])[:12])
ok = {}
for y, x in zip(*np.nonzero(m & ~bad)): ok[tuple(fr[y, x, :3].astype(int))] = ok.get(tuple(fr[y, x, :3].astype(int)), 0) + 1
print('drawn colours', sorted(ok.items(), key=lambda kv: -kv[1])[:12])
Image.fromarray(np.clip(fr,0,255).astype(np.uint8),'RGBA').resize((320,128),Image.NEAREST).save(f'{S}/expected.png')
