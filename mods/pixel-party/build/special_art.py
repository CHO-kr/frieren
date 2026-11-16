"""The battle stage's special moves (FrierenDot<v>-special.ttf, built by stage_art.py): every character's finishing move
(필살기) and what a long battle shows besides: the screen dimming for a special, the move's name on a banner, wave and
boss banners, and each member's SP gauge.

special_glyphs() -> {
  'shade', 'shadeTop': (64, [dim, flash])      tiled across the stage while a special plays (the top 4 rows separately)
  'gauge': (14, [0..4 filled, full blink])     a member's SP gauge, over its head
  'shock': (64, [3])                           dust and a ring rolling out on the ground
  'title': {WORDS: (w, [plain, glint])}        banners in 5x7 letters: each special's name, WAVE 1, WAVE 2, BOSS, ...
  'chars': {id: {'circle': (16, [3]), 'impact': (48, [3]), <its special's own art>: (w, [frames])}}
}
Drawn in each character's magic colors (anim.MAGIC).
"""
import numpy as np
import anim
from anim import Canvas, H, hexc, sparkle, circle

SPECIAL = {  # id -> (the move's name, how it plays: plan.js SPECIALS)
    'frieren': ('ZOLTRAAK', 'beam'), 'fern': ('ZOLTRAAK BARRAGE', 'barrage'), 'serie': ('RAIN OF LIGHT', 'rain'),
    'flamme': ('HELLFIRE', 'inferno'), 'denken': ('TEMPEST', 'tornado'), 'lawine': ('ICE LANCES', 'ice'),
    'kanne': ('TIDAL WAVE', 'tide'), 'methode': ('BINDING CHAINS', 'chains'), 'wirbel': ('THUNDERBOLT', 'thunder'),
    'land': ('MIRROR ARMY', 'mirror'), 'ubel': ('SEVERING CUT', 'cuts'), 'stark': ('SKY SPLITTER', 'skysplit'),
    'eisen': ('EARTHSHAKER', 'quake'), 'himmel': ("HERO'S FLASH", 'flash'), 'heiter': ('HOLY JUDGMENT', 'judgment'),
    'sein': ('SANCTUARY', 'sanctuary'),
}
BANNERS = ['WAVE 1', 'WAVE 2', 'BOSS', 'VICTORY!', 'RAGE!', 'SPECIAL']
FY = 16  # effects are drawn around this row, like the characters' own (anim.BATTLE)

L5 = {
    'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
    'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'I': ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
    'J': ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
    'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
    'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'S': ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
    'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
    'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    "'": ['#', '#', '.', '.', '.', '.', '.'],
    '!': ['#', '#', '#', '#', '#', '.', '#'],
    ' ': ['...', '...', '...', '...', '...', '...', '...'],
}


def rgb(h, a=255):
    return hexc(h, a)


def fade(c, a):
    return (c[0], c[1], c[2], int(a))


def disc(cv, cx, cy, rx, ry, c):
    for y in range(-ry, ry + 1):
        for x in range(-rx, rx + 1):
            if (x / max(rx, 0.5)) ** 2 + (y / max(ry, 0.5)) ** 2 <= 1.0:
                cv.px(cx + x, cy + y, c)


def line(cv, x0, y0, x1, y1, c, w=0, every=1):
    n = int(round(max(abs(x1 - x0), abs(y1 - y0), 1)))
    for k in range(n + 1):
        if k % every:
            continue
        x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
        cv.px(x, y, c)
        for d in range(1, w + 1):
            cv.px(x, y - d, c)
            cv.px(x, y + d, c)


def make(w, n, draw):
    out = []
    for f in range(n):
        cv = Canvas(w)
        draw(cv, f)
        out.append(cv.out())
    return (w, out)


def colors(cid):
    _, core, glow, deep = anim.MAGIC[cid]
    return rgb(core), rgb(glow), rgb(deep)


# ---------- what every long battle shows ----------
def shade_glyphs():
    dim, flash = (8, 6, 26, 136), (255, 250, 236, 119)

    def full(cv, f):
        for y in range(H):
            for x in range(64):
                cv.px(x, y, dim if f == 0 else flash)

    def top(cv, f):
        for y in range(4):
            for x in range(64):
                cv.px(x, y, dim if f == 0 else flash)
    return make(64, 2, full), make(64, 2, top)


def gauge_glyph():
    dark, empty = rgb('#1c1236'), rgb('#3e3462')
    lit = [rgb('#7fd8ff'), rgb('#7fd8ff'), rgb('#9fe6ff'), rgb('#ffd86a')]

    def g(cv, f):
        n = min(f, 4)
        for x in range(14):
            cv.px(x, 0, dark)
            cv.px(x, 4, dark)
        for y in range(1, 4):
            cv.px(0, y, dark)
            cv.px(13, y, dark)
        for x in range(1, 13):
            on = (x - 1) // 3 < n
            c = (rgb('#ffffff') if f == 5 else lit[n - 1]) if on else empty
            for y in range(1, 4):
                cv.px(x, y, (tuple(min(255, v + 60) for v in c[:3]) + (255,)) if y == 1 and on else c)
        for x in (4, 7, 10):
            if (x - 1) // 3 >= n:
                cv.px(x, 2, dark)
    return make(14, 6, g)


def shock_glyph():
    dust, dust2, ring = rgb('#d8c8a8', 220), rgb('#a89878', 200), rgb('#ffe9a8', 200)

    def g(cv, f):
        rx = [12, 22, 30][f]
        a = [230, 190, 110][f]
        circle(cv, 32, H - 2, rx, 2, fade(ring, a))
        for k in range(10):
            ang = np.pi * k / 9
            x = 32 + np.cos(ang) * rx * (0.6 + 0.4 * (k % 2))
            y = H - 3 - np.sin(ang) * (3 + f * 2) * (0.5 + 0.5 * ((k * 7) % 3) / 2)
            disc(cv, x, y, 2 - (f == 2), 1 + (f == 1), fade(dust if k % 2 else dust2, a))
        for k, dx in enumerate((-rx - 2, -rx // 2, rx // 2, rx + 2)):
            cv.px(32 + dx, H - 6 - f * 2 - k % 2, fade(dust2, a))
    return make(64, 3, g)


def title_glyph(word, fill=('#fff6d0', '#ffd86a'), ribbon='#18123a', edge='#ffd86a', shadow='#5a2a0a'):
    tw = sum(len(L5[c][0]) + 1 for c in word) - 1
    w = tw + 18

    def g(cv, f):
        rib, ed = rgb(ribbon, 230), rgb(edge)
        for x in range(4, w - 4):
            for y in range(1, 12):
                cv.px(x, y, ed if y in (1, 11) else rib)
        for k in range(5):  # swallowtail ends
            for y in range(1 + k, 12 - k):
                cv.px(4 - 1 - k if y not in (6,) else 4 - 1 - k, y, rib if k < 4 else ed)
                cv.px(w - 4 + k, y, rib if k < 4 else ed)
        for x in (0, w - 1):
            cv.px(x, 6, rgb('#000000', 0))
        x = 9
        top, bot = rgb(fill[0]), rgb(fill[1])
        for c in word:
            for j, row in enumerate(L5[c]):
                for i, ch in enumerate(row):
                    if ch == '#':
                        cv.px(x + i + 1, 3 + j + 1, rgb(shadow))
            for j, row in enumerate(L5[c]):
                for i, ch in enumerate(row):
                    if ch == '#':
                        cv.px(x + i, 3 + j, top if j < 3 else bot)
            x += len(L5[c][0]) + 1
        if f == 1:  # a glint sweeping across
            for k in range(-6, 7):
                for d in range(3):
                    gx = w * 0.62 + k * 0.5 + d - 6
                    cv.px(gx + k * 0.0, 2 + (k + 6) * 0.75, rgb('#ffffff', 150 - d * 40))
    return make(w, 2, g)


# ---------- each character's own ----------
def circle_v(cid):
    core, glow, deep = colors(cid)

    def g(cv, f):
        rx, ry = [(1, 5), (3, 10), (4, 12)][f]
        circle(cv, 8, FY, rx, ry, glow, phase=f * 1.1, hi=core)
        if f >= 1:
            circle(cv, 8, FY, max(1, rx - 1), max(2, ry - 4), fade(deep, 200))
        if f == 2:
            for k in range(6):
                t = k * np.pi / 3 + 0.4
                cv.px(8 + round((rx + 2) * np.cos(t)), FY + round((ry + 2) * np.sin(t)), core)
            sparkle(cv, 8, FY, 2, core, glow)
    return make(16, 3, g)


def impact(cid):
    core, glow, deep = colors(cid)
    cx, cy = 24, FY

    def g(cv, f):
        if f == 0:
            disc(cv, cx, cy, 9, 8, fade(glow, 220))
            disc(cv, cx, cy, 6, 5, core)
            for k in range(12):
                t = k * np.pi / 6
                r0, r1 = 10, 14 + (k % 2) * 6
                line(cv, cx + r0 * np.cos(t), cy + r0 * np.sin(t) * 0.9, cx + r1 * np.cos(t), cy + r1 * np.sin(t) * 0.9,
                     core if k % 2 else glow)
        elif f == 1:
            circle(cv, cx, cy, 13, 11, glow)
            circle(cv, cx, cy, 12, 10, fade(core, 200))
            circle(cv, cx, cy, 7, 6, fade(deep, 200))
            for k in range(8):
                t = k * np.pi / 4 + 0.39
                sparkle(cv, cx + 17 * np.cos(t), cy + 13 * np.sin(t), 2, core, glow)
        else:
            circle(cv, cx, cy, 17, 13, fade(deep, 150))
            for k in range(10):
                t = k * np.pi / 5 + 0.2
                sparkle(cv, cx + 20 * np.cos(t), cy + 14 * np.sin(t), 1 + k % 2, fade(core, 200), fade(glow, 150))
    return make(48, 3, g)


def mbeam(cid):
    core, glow, deep = colors(cid)

    def g(cv, f):
        for x in range(16):
            wob = 1 if (x + f) % 4 == 0 else 0
            for dy in range(-6 - wob, 7 + wob):
                a = abs(dy)
                if a <= 1:
                    c = rgb('#ffffff')
                elif a <= 3:
                    c = core
                elif a <= 5:
                    c = fade(glow, 230)
                else:
                    if (x + f) % 2:
                        continue
                    c = fade(deep, 170)
                cv.px(x, FY + dy, c)
            if (x + f * 3) % 7 == 0:
                cv.px(x, FY - 9, fade(glow, 200))
                cv.px(x, FY + 9, fade(glow, 160))
    return make(16, 2, g)


def spear(cid):
    core, glow, deep = colors(cid)

    def g(cv, f):
        hr = [5, 13, 21, 28][f]
        for k in range(12):
            y = hr - k
            a = max(40, 255 - k * 20)
            cv.px(4, y, fade(core, a))
            if k < 7:
                cv.px(3, y, fade(glow, a - 30))
                cv.px(5, y, fade(glow, a - 30))
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                cv.px(4 + dx, hr + dy, core if dx == 0 or dy == 0 else glow)
        cv.px(4, hr + 2, rgb('#ffffff'))
        if f == 3:
            for dx, dy in ((-3, -2), (3, -3), (-4, 0), (4, 0), (-2, -4), (2, -4)):
                cv.px(4 + dx, H - 2 + dy, glow)
            circle(cv, 4, H - 2, 4, 1, fade(core, 180))
    return make(10, 4, g)


FLAMES = [rgb('#fff8d0'), rgb('#ffd24a'), rgb('#ff8a2a'), rgb('#d83a1c'), rgb('#8a1c14', 200)]


def inferno(cid):
    tongues = [(-16, 0.7), (-8, 0.9), (0, 1.0), (8, 0.85), (16, 0.65)]
    heights = [[6, 8, 9, 7, 5], [16, 22, 26, 21, 14], [22, 28, 31, 27, 20], [9, 11, 13, 10, 7]]

    def g(cv, f):
        for k, (dx, k_) in enumerate(tongues):
            h = heights[f][k]
            half0 = 6 * k_ + (2 if f in (1, 2) else 0)
            for r in range(h):
                y = H - 1 - r
                t = r / max(1, h)
                half = half0 * (1 - t ** 1.4)
                sway = round(np.sin(r * 0.5 + f * 1.7 + k) * 1.2 * t)
                for x in range(-int(half) - 1, int(half) + 2):
                    d = abs(x) / max(half, 0.6)
                    if d > 1.15:
                        continue
                    c = FLAMES[0] if d < 0.3 and t < 0.6 else FLAMES[1] if d < 0.6 and t < 0.8 else FLAMES[2] if d < 0.9 else FLAMES[3]
                    if t > 0.85:
                        c = FLAMES[3]
                    cv.px(28 + dx + x + sway, y, c)
        if f in (2, 3):
            for k, (ex, ey) in enumerate(((-20, 6), (14, 2), (-4, 0), (22, 10), (6, 4))):
                cv.px(28 + ex, ey + f * 2, FLAMES[1 + k % 2])
        if f == 3:
            for dx, dy, r in ((-10, 10, 3), (6, 6, 4), (14, 12, 3)):
                disc(cv, 28 + dx, dy, r, r - 1, rgb('#6a5a6a', 150))
    return make(56, 4, g)


def tornado(cid):
    _, glow, deep = colors(cid)
    wind, wind2, edge = rgb('#f0fff6', 210), rgb('#a8e8cc', 200), rgb('#5aa88a', 170)

    def g(cv, f):
        for y in range(2, H):
            hw = 2.5 + (H - 1 - y) * 0.5
            cx = 20 + np.sin(y * 0.25 + f * 0.9) * 2
            for x in range(-int(hw), int(hw) + 1):
                band = (x * 0.9 + y * 0.6 + f * 3) % 6
                if abs(x) >= hw - 1:
                    c = edge
                elif band < 2:
                    c = wind
                elif band < 4:
                    c = wind2
                else:
                    continue
                cv.px(cx + x, y, c)
        for k in range(7):  # debris and embers whirling
            ang = f * 1.3 + k * 0.9
            y = 6 + k * 3.5
            r = 4 + (H - y) * 0.45
            c = glow if k % 2 else deep
            cv.px(20 + r * np.cos(ang), y, c)
            cv.px(20 + r * np.cos(ang) + 1, y, fade(c, 160))
        circle(cv, 20, H - 1, 8 + f % 2 * 2, 1, fade(wind2, 160))
    return make(40, 4, g)


def icespike(cid):
    core, glow, deep = colors(cid)
    out_c = rgb('#2a5a8a')

    def spike(cv, cx, tip, half):
        for y in range(tip, H):
            t = (y - tip) / max(1, H - 1 - tip)
            hw = max(0.5, half * t)
            for x in range(-int(round(hw)), int(round(hw)) + 1):
                edge = abs(x) >= round(hw)
                cv.px(cx + x, y, out_c if edge else core if x < 0 else glow if x == 0 else deep)
        cv.px(cx, tip - 1, rgb('#ffffff'))

    def g(cv, f):
        if f == 0:
            spike(cv, 8, 24, 3)
            spike(cv, 4, 28, 2)
        elif f == 1:
            spike(cv, 8, 8, 5)
            spike(cv, 3, 20, 3)
            spike(cv, 13, 17, 3)
            sparkle(cv, 6, 12, 2, rgb('#ffffff'), glow)
        else:
            for k, (dx, dy) in enumerate(((-5, 10), (4, 6), (-2, 2), (6, 14), (-6, 18), (2, 16), (7, 22))):
                disc(cv, 8 + dx, dy + 4, 1, 1 + k % 2, glow if k % 2 else core)
            spike(cv, 8, 24, 3)
    return make(16, 3, g)


def tide(cid):
    core, glow, deep = colors(cid)
    foam = rgb('#ffffff')

    def wave(cv, f):
        crest = 6 + f
        for x in range(48):
            if x < 34:
                top = 20 - x * (20 - crest) / 34 + np.sin(x * 0.5 + f) * 1
            else:
                top = crest + (x - 34) ** 1.6 * 0.6
            for y in range(int(top), H):
                d = y - top
                c = foam if d < 1 else core if d < 3 else glow if d < 8 else deep
                if x >= 34 and y > top + 6 and y < H - 6:
                    continue  # the curl's hollow
                cv.px(x, y, c)
        for k in range(6):
            sparkle(cv, 30 + k * 3 + f, crest - 2 - (k % 3) * 2, 1 + (k + f) % 2, foam, fade(core, 180))
    w = make(48, 3, wave)

    def splash(cv, f):
        for k in range(12):
            ang = np.pi * (0.1 + 0.8 * k / 11)
            r = [10, 16][f] + (k % 3) * 2
            x, y = 20 + np.cos(ang) * r, H - 2 - np.sin(ang) * r * 1.1
            disc(cv, x, y, 1, 1 + (k % 2), core if k % 2 else glow)
        circle(cv, 20, H - 2, 12 + f * 6, 2, fade(foam, 200 - f * 60))
    return w, make(40, 2, splash)


def chains(cid):
    core, glow, deep = colors(cid)
    dark = rgb('#4a1a3a')

    def chain(cv, x0, y0, x1, y1, part, bright):
        n = int(max(abs(x1 - x0), abs(y1 - y0)))
        for k in range(int(n * part)):
            x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
            m = k % 4
            if m == 3:
                cv.px(x, y, dark)
                continue
            c = core if bright and m == 1 else glow if m else deep
            cv.px(x, y, c)
            if m == 1:
                cv.px(x, y - 1, fade(c, 180))

    def g(cv, f):
        part = [0.5, 1.0, 1.0][f]
        chain(cv, 4, H - 1, 44, 4, part, f == 2)
        chain(cv, 44, H - 1, 4, 4, part, f == 2)
        if f >= 1:
            chain(cv, 2, FY + 2, 46, FY, 1.0, f == 2)
        if f == 2:
            for k, (x, y) in enumerate(((24, FY + 1), (10, 8), (38, 8), (12, 26), (36, 26))):
                sparkle(cv, x, y, 2 if k == 0 else 1, core, glow)
    return make(48, 3, g)


def lightning(cid):
    core, glow, deep = rgb('#ffffff'), rgb('#bfe0ff'), rgb('#6a8cff')
    path = [(12, 0), (9, 5), (14, 9), (10, 14), (15, 19), (11, 24), (13, 28), (12, 31)]

    def g(cv, f):
        for (ax, ay), (bx, by) in zip(path, path[1:]):
            if f == 0:
                line(cv, ax, ay, bx, by, fade(glow, 200))
            elif f == 1:
                for d in (-1, 1):
                    line(cv, ax + d, ay, bx + d, by, glow)
                line(cv, ax, ay, bx, by, core)
            else:
                line(cv, ax, ay, bx, by, fade(deep, 140))
        if f == 1:
            line(cv, 14, 9, 20, 13, glow)
            line(cv, 15, 19, 21, 22, fade(glow, 200))
            line(cv, 10, 14, 4, 18, fade(glow, 200))
            disc(cv, 12, H - 2, 8, 2, fade(core, 200))
        if f == 2:
            for dx, dy in ((-6, -3), (6, -2), (-3, -6), (4, -7)):
                sparkle(cv, 12 + dx, H - 2 + dy, 1, core, glow)
    return make(24, 3, g)


def cuts(cid):
    core, glow, deep = colors(cid)
    cx, cy = 24, FY
    lines_ = [(-16, -12, 16, 12), (16, -13, -16, 13), (-21, 1, 21, -2), (-11, -15, 9, 15), (-19, 9, 19, -9)]

    def g(cv, f):
        n = min(5, f + 2) if f < 3 else 5
        for k, (a, b, c_, d) in enumerate(lines_[:n]):
            newest = k == n - 1 and f < 3
            col = rgb('#ffffff') if newest or f == 3 else fade(core, 200)
            line(cv, cx + a, cy + b, cx + c_, cy + d, fade(glow, 200 if newest or f == 3 else 120), w=1)
            line(cv, cx + a, cy + b, cx + c_, cy + d, col)
        if f == 3:
            for k in range(6):
                t = k * np.pi / 3
                sparkle(cv, cx + 14 * np.cos(t), cy + 11 * np.sin(t), 2, core, glow)
    return make(48, 4, g)


def bigslash(cid):
    core, glow, deep = colors(cid)

    def g(cv, f):
        dx = [0, 3, 5][f]
        for y in range(1, H):
            t = (y - 16) / 15
            x = 14 + dx + round(12 * (1 - t * t))
            th = round(3.5 * (1 - abs(t)) + 0.5)
            for k in range(th + 2):
                if f == 2 and (y + k) % 3:
                    continue
                c = rgb('#ffffff') if k < th // 2 + 1 else core if k < th else fade(glow, 220) if k == th else fade(deep, 160)
                if f == 1:
                    c = fade(c, 190)
                cv.px(x - k, y, c)
        if f >= 1:
            for k in range(6):
                sparkle(cv, 28 + dx + (k % 3) * 2, 4 + k * 5, 1 + (k + f) % 2, core, glow)
    return make(40, 3, g)


def rocks(cid):
    _, glow, _ = colors(cid)
    stone, stone2, lite, crack = rgb('#8a7a6a'), rgb('#6a5a4c'), rgb('#c8b8a0'), rgb('#2a1c14')

    def rock(cv, cx, tip, half, lean=0):
        for y in range(tip, H):
            t = (y - tip) / max(1, H - 1 - tip)
            hw = max(1, half * (0.4 + 0.6 * t))
            for x in range(-int(hw), int(hw) + 1):
                c = lite if x == -int(hw) else stone2 if x > hw * 0.3 else stone
                cv.px(cx + x + round(lean * (1 - t)), y, c)
        cv.px(cx + lean, tip - 1, fade(glow, 220))

    def g(cv, f):
        if f == 0:
            line(cv, 2, H - 1, 18, H - 2, crack)
            line(cv, 8, H - 1, 12, H - 3, crack)
            rock(cv, 10, H - 4, 2)
        elif f == 1:
            rock(cv, 10, 12, 5)
            rock(cv, 4, 20, 3, -1)
            rock(cv, 16, 18, 3, 1)
            for dx, dy in ((-6, 10), (7, 8), (0, 6)):
                cv.px(10 + dx, dy, glow)
        else:
            rock(cv, 10, 22, 4)
            for k, (dx, dy) in enumerate(((-7, 8), (6, 6), (-3, 3), (8, 14), (-8, 16))):
                disc(cv, 10 + dx, dy, 1, 1, stone if k % 2 else lite)
    return make(20, 3, g)


def flashline(cid):
    core, glow, _ = colors(cid)

    def g(cv, f):
        for k, (y, x0, x1) in enumerate(((10, 6, 50), (14, 0, 64), (17, 2, 60), (21, 10, 58), (25, 4, 40))):
            for x in range(x0, x1):
                if f == 1 and (x + k * 3) % 5 == 0:
                    continue
                cv.px(x, y, rgb('#ffffff') if k in (1, 2) else core)
                if k in (1, 2):
                    cv.px(x, y - 1, fade(glow, 180))
    return make(64, 2, g)


def xcut(cid):
    core, glow, deep = colors(cid)
    cx, cy = 20, FY

    def g(cv, f):
        pairs = [(-14, -12, 14, 12)] + ([(14, -12, -14, 12)] if f >= 1 else [])
        for a, b, c_, d in pairs:
            al = 255 if f < 2 else 150
            line(cv, cx + a, cy + b, cx + c_, cy + d, fade(glow, al * 0.8), w=2 if f == 1 else 1)
            line(cv, cx + a, cy + b, cx + c_, cy + d, fade(rgb('#ffffff'), al))
        if f >= 1:
            disc(cv, cx, cy, 3, 3, rgb('#ffffff'))
            for k in range(6):
                t = k * np.pi / 3 + 0.5
                sparkle(cv, cx + 15 * np.cos(t), cy + 12 * np.sin(t), 2 if f == 1 else 1, core, glow)
    return make(40, 3, g)


def judgment(cid):
    core, glow, deep = colors(cid)

    def cross(cv, cx, top, s):
        for y in range(top, top + 3 * s + 1):
            cv.px(cx, y, core)
            cv.px(cx - 1, y, glow)
            cv.px(cx + 1, y, glow)
        for x in range(cx - s - 1, cx + s + 2):
            cv.px(x, top + s, core)
            cv.px(x, top + s - 1, glow)

    def g(cv, f):
        if f == 0:
            cross(cv, 20, 1, 3)
            sparkle(cv, 20, 4, 3, rgb('#ffffff'), glow)
        else:
            half = [0, 4, 8, 6][f]
            al = [0, 230, 240, 130][f]
            for y in range(H):
                for dx in range(-half, half + 1):
                    inner = abs(dx) <= half // 2
                    cv.px(20 + dx, y, fade(rgb('#ffffff') if abs(dx) <= 1 else core if inner else glow, al if inner else al * 0.6))
            cross(cv, 20, 0, 4)
            if f >= 2:
                circle(cv, 20, H - 2, 14, 2, fade(glow, 220))
                for k in range(5):
                    sparkle(cv, 20 + (k - 2) * 7, H - 6 - (k * 5 + f * 3) % 20, 2, rgb('#ffffff'), glow)
    return make(40, 4, g)


def sanct(cid):
    core, glow, deep = colors(cid)

    def g(cv, f):
        circle(cv, 32, H - 2, 28, 3, glow, phase=f * 0.9, hi=core)
        circle(cv, 32, H - 2, 22, 2, fade(deep, 200))
        if f >= 1:
            for k, x in enumerate((8, 18, 28, 38, 48, 56)):
                h = 8 + ((k * 5 + f * 3) % 8)
                for y in range(H - 2 - h, H - 2):
                    cv.px(x, y, fade(core if k % 2 else glow, (150 if f == 1 else 210) * (y - (H - 2 - h)) / h + 30))
            for x in (16, 32, 48):
                top = H - 22 - (f * 3) % 6
                for y in range(top, top + 5):
                    cv.px(x, y, rgb('#ffffff'))
                for dx in (-1, 1):
                    cv.px(x + dx, top + 1, rgb('#ffffff'))
        if f == 2:
            for k in range(6):
                sparkle(cv, 6 + k * 10, H - 14 - (k % 3) * 4, 2, rgb('#ffffff'), glow)
    return make(64, 3, g)


ART = {  # how a special plays -> its own pieces (besides circle and impact)
    'beam': {'mbeam': mbeam}, 'rain': {'spear': spear}, 'inferno': {'inferno': inferno}, 'tornado': {'tornado': tornado},
    'ice': {'icespike': icespike}, 'chains': {'chains': chains}, 'thunder': {'lightning': lightning},
    'cuts': {'cuts': cuts}, 'skysplit': {'bigslash': bigslash}, 'quake': {'rocks': rocks},
    'flash': {'flashline': flashline, 'xcut': xcut}, 'judgment': {'judgment': judgment},
    'sanctuary': {'sanct': sanct, 'spear': spear},
}


def special_glyphs():
    shade, shade_top = shade_glyphs()
    out = {'shade': shade, 'shadeTop': shade_top, 'gauge': gauge_glyph(), 'shock': shock_glyph(), 'title': {}, 'chars': {}}
    for cid, (name, how) in SPECIAL.items():
        out['title'][name] = title_glyph(name)
        own = {'circle': circle_v(cid), 'impact': impact(cid)}
        if how == 'tide':
            own['tide'], own['splash'] = tide(cid)
        for key, fn in ART.get(how, {}).items():
            own[key] = fn(cid)
        out['chars'][cid] = own
    for b in BANNERS:
        if b == 'RAGE!':
            out['title'][b] = title_glyph(b, fill=('#ffd0c0', '#ff4a3a'), ribbon='#3a0a14', edge='#ff7a5a', shadow='#2a0000')
        elif b == 'VICTORY!':
            out['title'][b] = title_glyph(b, fill=('#ffffff', '#9ff0b0'), ribbon='#0e2a26', edge='#9ff0b0', shadow='#05261a')
        else:
            out['title'][b] = title_glyph(b)
    return out
