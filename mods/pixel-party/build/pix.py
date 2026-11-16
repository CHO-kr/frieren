import sys, numpy as np
from PIL import Image
def cellmode(im, W, H, colors=24):
    im = im.convert('RGB')
    # quantize first to a palette so "mode" is meaningful
    q = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = np.array(q.getpalette()[:colors*3]).reshape(-1,3)
    a = np.asarray(q)
    h, w = a.shape
    out = np.zeros((H, W, 3), np.uint8)
    for y in range(H):
        for x in range(W):
            y0, y1 = int(y*h/H), int((y+1)*h/H); x0, x1 = int(x*w/W), int((x+1)*w/W)
            # inner 60% of the cell to avoid edge bleed
            my, mx = (y1-y0)//5, (x1-x0)//5
            c = a[y0+my:y1-my, x0+mx:x1-mx].ravel()
            out[y, x] = pal[np.bincount(c).argmax()]
    return Image.fromarray(out)
src = Image.open(sys.argv[1])
outs = []
for W,H in [(32,48),(40,60),(48,72)]:
    o = cellmode(src, W, H)
    o.save(sys.argv[2] + f'_{W}x{H}.png')
    outs.append(o.resize((W*2, H*2), Image.NEAREST))
sheet = Image.new('RGB', (sum(o.width for o in outs) + 40, max(o.height for o in outs) + 20), (40,40,40))
x = 10
for o in outs: sheet.paste(o, (x, 10)); x += o.width + 10
sheet = sheet.resize((sheet.width*3, sheet.height*3), Image.NEAREST)
sheet.save(sys.argv[2] + '_sheet.png')
