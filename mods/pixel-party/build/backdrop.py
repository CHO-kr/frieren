import sys, random
from PIL import Image
def hx(h): h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def backdrop(W, seed=3):
    random.seed(seed)
    H = 32
    im = Image.new('RGB', (W, H))
    p = im.load()
    sky1, sky2, sky3, glow, hill, hill2, grass, grass2, tuft = map(hx, ['#3e4699', '#525ab4', '#6e6cc6', '#a98cc8', '#34448a', '#2c3a78', '#2f6b52', '#3a7e5e', '#5aa673'])
    for y in range(H):
        for x in range(W):
            if y < 9: c = sky1
            elif y < 14: c = sky2 if (x + y) % 2 == 0 or y >= 12 else sky1
            elif y < 18: c = sky3 if (x + y) % 2 == 0 or y >= 16 else sky2
            elif y == 18: c = glow
            else: c = sky3
            p[x, y] = c
    for k in range(W // 9):
        x, y = random.randrange(W), random.randrange(8)
        p[x, y] = hx('#c8d0ff')
    # far hills: bumpy ridge
    ridge = [19 + int(2.2 * (1 + __import__('math').sin(x / 6.0 + 1.3)) + (1 if (x // 5) % 3 == 0 else 0)) for x in range(W)]
    for x in range(W):
        for y in range(ridge[x], 25):
            p[x, y] = hill if y > ridge[x] else hx('#4a5aa8')
    # grass
    for y in range(25, H):
        for x in range(W):
            p[x, y] = grass2 if y == 25 else (grass if (x + y) % 3 else grass2)
    for k in range(W // 4):
        x = random.randrange(W); y = random.randrange(26, H)
        p[x, y] = tuft
    for k in range(W // 10):
        x = random.randrange(1, W - 1); y = random.randrange(27, H - 1)
        p[x, y] = random.choice([hx('#ffffff'), hx('#a8c8ff'), hx('#ffd0e8')])
    return im
backdrop(80).resize((160, 64), Image.NEAREST).save(sys.argv[1] + '/backdrop-stage.png')
backdrop(36, seed=5).resize((72, 64), Image.NEAREST).save(sys.argv[1] + '/backdrop-solo.png')
cv = Image.new('RGB', (130, 32)); cv.paste(backdrop(80), (0, 0)); cv.paste(backdrop(36, 5), (90, 0)); cv.resize((520, 128), Image.NEAREST).save(sys.argv[2])

