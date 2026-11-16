import sys, numpy as np
from PIL import Image
from fontTools.ttLib import TTFont
SHOT, FONT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
f = TTFont(FONT); glyf = f['glyf']; L = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; cm = f.getBestCmap()
U = 32; H = 32
def render(cp, W=80):
    im = np.zeros((H, W, 4), np.uint8)
    for lay in L[cm[cp]]:
        g = glyf[lay.name]; c = pal[lay.colorID]
        if g.numberOfContours <= 0: continue
        co = g.coordinates; st = 0
        for e in g.endPtsOfContours:
            pts = list(co[st:e+1]); st = e + 1
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            im[H - max(ys)//U:H - min(ys)//U, min(xs)//U:max(xs)//U] = (c.red, c.green, c.blue, c.alpha)
    return Image.fromarray(im, 'RGBA')
cv = Image.new('RGBA', (4 * 84, 4 * 36), (40, 40, 40, 255))
for i, cp in enumerate(range(0xE00A, 0xE016)):
    cv.alpha_composite(render(cp), ((i % 4) * 84, (i // 4) * 36))
shot = Image.open(SHOT).convert('RGBA').crop((300, 66, 480, 150)).resize((90, 42), Image.NEAREST)
big = Image.new('RGBA', (4 * 84, 3 * 36 + 46), (0, 0, 0, 255)); big.paste(cv.crop((0, 0, 4*84, 3*36)), (0, 0)); big.paste(shot, (0, 3 * 36 + 2))
big.resize((big.width * 3, big.height * 3), Image.NEAREST).save(OUT)
