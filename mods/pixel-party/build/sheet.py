import sys, glob, os, numpy as np
from PIL import Image
from fontTools.ttLib import TTFont
FONTS, BD, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
U = 32; H = 32
ANIMS = [('rest', 0xE000, 4), ('think', 0xE006, 4), ('cast', 0xE00A, 12), ('read', 0xE016, 6), ('write', 0xE01C, 8), ('fly', 0xE024, 6), ('summon', 0xE02A, 8), ('alert', 0xE032, 2), ('victory', 0xE034, 8)]
bd = Image.open(BD).convert('RGBA').resize((80, 32), Image.NEAREST)
def render(f, cp):
    glyf = f['glyf']; L = f['COLR'].ColorLayers; pal = f['CPAL'].palettes[0]; cm = f.getBestCmap()
    im = np.zeros((H, 80, 4), np.uint8)
    for lay in L[cm[cp]]:
        g = glyf[lay.name]; c = pal[lay.colorID]
        if g.numberOfContours <= 0: continue
        co = g.coordinates; st = 0
        for e in g.endPtsOfContours:
            pts = list(co[st:e+1]); st = e + 1
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            im[H - max(ys)//U:H - min(ys)//U, min(xs)//U:max(xs)//U] = (c.red, c.green, c.blue, c.alpha)
    return Image.fromarray(im, 'RGBA')
files = sorted(glob.glob(os.path.join(FONTS, 'FrierenDot3-*.ttf')))
cv = Image.new('RGBA', (len(ANIMS) * 82, len(files) * 34), (0, 0, 0, 255))
for r, fp in enumerate(files):
    f = TTFont(fp)
    for c, (nm, base, n) in enumerate(ANIMS):
        tile = bd.copy(); tile.alpha_composite(render(f, base + (n * 2) // 3 if n > 2 else base)); cv.paste(tile, (c * 82, r * 34))
cv.resize((cv.width * 2, cv.height * 2), Image.NEAREST).save(OUT)
print([os.path.basename(p)[12:-4] for p in files])
