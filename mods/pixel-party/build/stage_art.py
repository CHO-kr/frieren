"""The battle stage's art (pixel-pane's stage block), besides the characters' own fonts (anim.py):
- scenes/<scene>.png   a 512 x 36 strip of each background's 512 x 288 art (the ground), saved at 2x: the stage shows
                       as much of it as fits, around the scene's anchor
- fonts/FrierenDot<v>-monsters.ttf   one monster per background scene and a golem for bigger parties: idle, hurt,
                       attack (a wind-up and a lunge) and spawn (fading in) frames
- fonts/FrierenDot<v>-fx.ttf         what a battle shows besides sprites: damage numbers and words rising, the monster's HP
                       bar, each monster's projectile and its hit, smoke, a scan, a rune circle and pillar, healing, sparks,
                       a summoning circle and sparkles
- fonts/FrierenDot<v>-props.ttf      campfire (lit, embers, cooking pot), tent, chests, bedroll, signpost, backpack, ring
- <pixel-pane>/stage.js  every code point and width, the characters' attack tips and the monsters' shapes

usage: python stage_art.py <herdr home> [atlas dir: every glyph as an image, for stage_preview.py]
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageEnhance

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anim  # noqa: E402
from anim import Canvas, H, hexc, sparkle, holy, circle  # noqa: E402
from halve import halve  # noqa: E402
import special_art  # noqa: E402

V = anim.FONT_VERSION
HERE = os.path.dirname(os.path.abspath(__file__))

# background scene -> (first row of the strip, mirrored, brightness, the monster met there, anchor: which part of the
# 512 columns a narrower stage shows, 0 left .. 1 right)
SCENES = {
    'night': (224, False, 1.0, 'wyvern', 0.5),
    'dawn-flowers': (240, False, 1.0, 'slime', 0.5),
    'meteor-night': (240, False, 1.25, 'wisp', 1.0),
    'snow-north': (228, False, 1.0, 'wolf', 0.5),
    'autumn-road': (224, False, 1.0, 'stump', 0.5),
    'mage-library': (236, False, 1.2, 'mimic', 0.6),
    'lakeside-town': (236, True, 1.0, 'serpent', 0.0),
}
SH = 36           # stage rows (shown at 2x = 72 px); 32-row glyphs stand on its floor, 4 rows below the top
STRIP_W = 512
MONSTERS = {  # name, rows above the ground it hovers, bob, its attack
    'wyvern': ('Wyvern', 3, True, 'fire'), 'slime': ('Blue Slime', 0, False, 'goo'),
    'wisp': ("Will-o'-Wisp", 5, True, 'wisp'), 'wolf': ('Frost Wolf', 0, False, 'ice'),
    'stump': ('Grumpy Stump', 0, False, 'thorn'), 'mimic': ('Mimic', 0, False, 'coin'),
    'serpent': ('Lake Serpent', 0, False, 'water'), 'golem': ('Stone Golem', 0, False, 'rock'),
}
MW, MX0 = 60, 14  # monster glyph width, the sprite's left edge in it (room to lunge 10 left and be knocked back)


def band(home, scene):
    start, mirror, bright, _, _ = SCENES[scene]
    a = np.asarray(Image.open(f'{home}/backgrounds/frieren-pixel-{scene}.png').convert('RGB'))[2::5, 2::5]
    nat = Image.fromarray(a[start:start + SH, :STRIP_W])
    if mirror:
        nat = nat.transpose(Image.FLIP_LEFT_RIGHT)
    if bright != 1.0:
        nat = ImageEnhance.Brightness(nat).enhance(bright)
    return nat


# ---------- monsters ----------
def put(cv, spr, x, y, tint=None, k=0.0):
    h, w = spr.shape[:2]
    for j in range(h):
        for i in range(w):
            if spr[j, i, 3]:
                c = spr[j, i, :3].astype(float)
                if tint is not None:
                    c = c * (1 - k) + np.array(tint) * k
                cv.px(x + i, y + j, (int(c[0]), int(c[1]), int(c[2]), 255))


def ground_shadow(cv, x0, w, alpha=80):
    for dx in range(w):
        edge = dx < 2 or dx >= w - 2
        cv.px(x0 + dx, H - 1, (10, 12, 30, alpha // 2 if edge else alpha))


def monster_frames(spr, hover, bob):
    """idle (4, a bob or a lean), hurt (2: a white flash, red and knocked back), attack (4: wind-up, lunge, hold, back),
    spawn (2: fading in); and where its mouth and middle are"""
    h, w = spr.shape[:2]
    base_y = H - h - hover

    def frame(dx=0, dy=0, tint=None, k=0.0, alpha=1.0):
        cv = Canvas(MW)
        ground_shadow(cv, MX0 + w // 6 + min(dx, 0), w * 2 // 3, 60 if hover else 90)
        put(cv, spr, MX0 + dx, base_y + dy, tint, k)
        if alpha < 1:
            cv.a[..., 3] *= alpha
        return cv.out()
    out = {
        'idle': [frame(0, d) for d in (0, -1, -1, 0)] if bob else [frame(0), frame(-1), frame(-1), frame(0)],
        'hurt': [frame(3, 0, (255, 255, 255), 0.75), frame(2, 0, (255, 70, 70), 0.4)],
        'attack': [frame(3, -1, (255, 230, 200), 0.15), frame(-8, 0), frame(-10, 0, (255, 240, 220), 0.1), frame(-4, 0)],
        'spawn': [frame(0, 0, (255, 255, 255), 0.6, 0.35), frame(0, 0, (255, 255, 255), 0.25, 0.7)],
    }
    a = spr[..., 3] > 0
    upper = a[: max(1, h * 3 // 5)]
    cols = np.nonzero(upper.any(0))[0]
    mx = int(cols.min()) if len(cols) else 0
    ys = np.nonzero(upper[:, mx])[0]
    geo = {'w': int(w), 'h': int(h), 'x0': MX0, 'top': int(base_y),
           'mouth': [MX0 + mx, int(base_y + (ys.mean() if len(ys) else h // 3))], 'mid': int(base_y + h // 2)}
    return out, geo


# ---------- fx ----------
GLYPH = {
    '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'], '2': ['###', '..#', '###', '#..', '###'],
    '3': ['###', '..#', '.##', '..#', '###'], '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '###', '..#', '###'],
    '6': ['###', '#..', '###', '#.#', '###'], '7': ['###', '..#', '.#.', '.#.', '.#.'], '8': ['###', '#.#', '###', '#.#', '###'],
    '9': ['###', '#.#', '###', '..#', '###'], '+': ['...', '.#.', '###', '.#.', '...'],
    'B': ['##.', '#.#', '##.', '#.#', '##.'], 'C': ['.##', '#..', '#..', '#..', '.##'], 'E': ['###', '#..', '##.', '#..', '###'],
    'A': ['.#.', '#.#', '###', '#.#', '#.#'], 'I': ['###', '.#.', '.#.', '.#.', '###'], 'K': ['#.#', '#.#', '##.', '#.#', '#.#'],
    'L': ['#..', '#..', '#..', '#..', '###'], 'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'], 'O': ['.#.', '#.#', '#.#', '#.#', '.#.'],
    'R': ['##.', '#.#', '##.', '#.#', '#.#'], 'S': ['.##', '#..', '.#.', '..#', '##.'], 'T': ['###', '.#.', '.#.', '.#.', '.#.'],
    'W': ['#...#', '#...#', '#.#.#', '##.##', '#...#'], '!': ['#', '#', '#', '.', '#'],
    'U': ['#.#', '#.#', '#.#', '#.#', '###'], 'P': ['##.', '#.#', '##.', '#..', '#..'], 'Y': ['#.#', '#.#', '.#.', '.#.', '.#.'],
    'F': ['###', '#..', '##.', '#..', '#..'], 'N': ['#..#', '##.#', '#.##', '#..#', '#..#'], 'D': ['##.', '#.#', '#.#', '#.#', '##.'],
    'H': ['#.#', '#.#', '###', '#.#', '#.#'], 'G': ['.##', '#..', '#.#', '#.#', '.##'], ' ': ['.', '.', '.', '.', '.'],
}
INK = {  # fill, outline
    'dmg': ((255, 255, 255), (40, 24, 56)), 'crit': ((255, 214, 74), (92, 40, 0)), 'hurt': ((255, 112, 112), (62, 8, 22)),
    'heal': ((140, 255, 160), (8, 56, 24)), 'MISS': ((206, 222, 255), (30, 40, 84)), 'BLOCK': ((150, 206, 255), (18, 40, 92)),
    'CRIT!': ((255, 214, 74), (92, 40, 0)), 'WEAK!': ((255, 172, 92), (82, 30, 0)), 'KO!': ((255, 96, 76), (64, 0, 0)),
    'COMBO!': ((255, 236, 120), (110, 30, 70)), 'ATK UP': ((255, 150, 110), (80, 16, 10)), 'RALLY!': ((255, 220, 110), (24, 40, 110)),
    'FOUND!': ((180, 255, 170), (14, 60, 30)), 'COUNTER': ((170, 220, 255), (14, 34, 90)), 'HELP!': ((255, 255, 255), (170, 30, 40)),
    'MIMIC!': ((255, 200, 90), (90, 20, 50)), 'BOOM!': ((255, 170, 60), (90, 14, 0)), 'FORGED!': ((255, 200, 120), (70, 36, 10)),
    'TACTICS': ((240, 226, 180), (70, 50, 20)),
}
NUM_TOP, RISES = 9, 4  # a number's top row (in a 32-row glyph), and the steps it rises (2 rows each)
NUM_ADV = 4           # digits are 3 wide + a gap; their outline spills into the gap


def text_glyph(s, ink, rise):
    """a string in 3x5 pixel letters with a 1px outline: (width, frame)"""
    fill, line = ink
    w = sum(len(GLYPH[c][0]) + 1 for c in s) + 1
    cv = Canvas(w + 1)
    top = NUM_TOP - 2 * rise
    x, pts = 1, []
    for c in s:
        for j, row in enumerate(GLYPH[c]):
            for i, ch in enumerate(row):
                if ch == '#':
                    pts.append((x + i, top + j))
        x += len(GLYPH[c][0]) + 1
    on = set(pts)
    for px_, py in pts:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (px_ + dx, py + dy) not in on:
                    cv.px(px_ + dx, py + dy, line + (255,))
    for p in pts:
        cv.px(p[0], p[1], fill + (255,))
    return w, cv.out()


ATTACK_INK = {  # core, body, edge
    'fire': ('#fff6c0', '#ffa030', '#d8401c'), 'goo': ('#e8f4ff', '#6aa8ff', '#2f5fc0'), 'wisp': ('#ffffff', '#b4a0ff', '#6a4fe0'),
    'ice': ('#ffffff', '#bfe8ff', '#5aa0d8'), 'thorn': ('#d8f0a0', '#7a9a3a', '#5a3a1c'), 'coin': ('#fff6c0', '#ffd040', '#a87010'),
    'water': ('#f0fbff', '#5ab4f0', '#2a6ab0'), 'rock': ('#d8c8b0', '#9a8670', '#5a4a3c'),
}
FX_Y = 16  # projectiles, hits, scans and sparks are drawn around this row


def fx_glyphs():
    """key -> (width, [frames]), or nested dicts of those (numbers, words, the monsters' attacks)"""
    gold, gold2, white = hexc('#ffd86a'), hexc('#fff2b0'), hexc('#ffffff')
    out = {}

    def small(w, draw):
        cv = Canvas(w)
        draw(cv)
        return cv.out()

    out['num'] = {c: [[text_glyph(d, INK[c], r)[1] for d in '0123456789+'] for r in range(RISES)] for c in ('dmg', 'crit', 'hurt', 'heal')}
    out['word'] = {}
    for wd in (k for k in INK if k not in ('dmg', 'crit', 'hurt', 'heal')):
        g = [text_glyph(wd, INK[wd], r) for r in range(RISES)]
        out['word'][wd] = (g[0][0], [f for _, f in g])

    def hp(cv, k):
        dark = (22, 16, 40, 255)
        for x in range(30):
            cv.px(x, 1, dark)
            cv.px(x, 5, dark)
        for y in range(2, 5):
            cv.px(0, y, dark)
            cv.px(29, y, dark)
        fill = (120, 230, 120) if k > 5 else (255, 210, 80) if k > 2 else (255, 90, 80)
        n = round(28 * k / 10)
        for x in range(1, 29):
            for y in range(2, 5):
                lit = x - 1 < n
                c = (tuple(min(255, v + 50) for v in fill) if y == 2 else fill) if lit else (64, 52, 86)
                cv.px(x, y, c + (255,))
    out['hp'] = (30, [small(30, lambda cv, k=k: hp(cv, k)) for k in range(11)])

    def proj(cv, kind, f):
        core, body, edge = (hexc(c) for c in ATTACK_INK[kind])
        cx, cy = 6, FX_Y
        if kind in ('fire', 'wisp'):
            for dx in range(1, 7):  # the tail behind it (it flies left)
                for dy in range(-2 + dx // 3, 3 - dx // 3):
                    if (dx + dy + f) % 3:
                        cv.px(cx + dx + 1, cy + dy, edge if dx > 3 else body)
            holy(cv, cx, cy, (None,) + ATTACK_INK[kind], r=3 - f)
        elif kind == 'ice':
            for dx, half in ((-4, 0), (-3, 1), (-2, 1), (-1, 2), (0, 2), (1, 2), (2, 1), (3, 1), (4, 0)):
                for dy in range(-half, half + 1):
                    cv.px(cx + dx, cy + dy, core if abs(dy) < half or half == 0 else body)
            cv.px(cx + 6 + f, cy, edge)
            cv.px(cx + 7 + f, cy - 1, body)
        elif kind == 'coin':
            rx = 3 if f == 0 else 1
            for dy in range(-3, 4):
                for dx in range(-rx, rx + 1):
                    if abs(dx) / max(rx, 1) + abs(dy) / 3 <= 1.2:
                        cv.px(cx + dx, cy + dy, core if dx == 0 and abs(dy) < 2 else body)
            cv.px(cx + rx + 1, cy, edge)
        else:  # goo, thorn, water, rock: a round lump
            for dy in range(-3, 4):
                for dx in range(-3, 4):
                    d = dx * dx + dy * dy
                    if d <= 10:
                        cv.px(cx + dx, cy + dy, edge if d > 6 else body)
            cv.px(cx - 1, cy - 1, core)
            cv.px(cx, cy - 2, core)
            if kind == 'thorn':
                for dx, dy in ((-4, 0), (4, 0), (0, -4), (0, 4), (3, 3), (-3, -3)):
                    cv.px(cx + dx, cy + dy, core)
            if kind in ('goo', 'water'):
                cv.px(cx + 5 + f, cy + 1, body)
                cv.px(cx + 6, cy - 1 + f, edge)

    def hit(cv, kind, f):
        core, body, edge = (hexc(c) for c in ATTACK_INK[kind])
        cx, cy = 11, FX_Y
        if f == 0:
            for t in range(8):
                ang = t * np.pi / 4
                for r in range(2, 7):
                    cv.px(cx + round(r * np.cos(ang)), cy + round(r * np.sin(ang)), core if r < 4 else body)
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    cv.px(cx + dx, cy + dy, core)
        else:
            for t in range(10):
                ang = t * np.pi / 5 + 0.3
                r = 7 + (t % 3)
                cv.px(cx + round(r * np.cos(ang)), cy + round(r * np.sin(ang)), body if t % 2 else edge)
    out['mon'] = {k: {'proj': (14, [small(14, lambda cv, k=k, f=f: proj(cv, k, f)) for f in range(2)]),
                      'hit': (22, [small(22, lambda cv, k=k, f=f: hit(cv, k, f)) for f in range(2)])} for k in ATTACK_INK}

    def smoke(cv, f):
        for k, (dx, dy, r) in enumerate(((0, 0, 5), (-7, 3, 4), (7, 2, 4), (-3, -6, 4), (5, -5, 3), (0, 6, 3))):
            rr = r + f * 2
            al = [230, 170, 90][f]
            for yy in range(-rr, rr + 1):
                for xx in range(-rr, rr + 1):
                    if xx * xx + yy * yy <= rr * rr and (xx + yy + k + f) % (2 + f) == 0:
                        cv.px(20 + dx * (1 + f * 0.4) + xx, 20 + dy + yy - f * 2, (226, 222, 236, al) if yy < 0 else (170, 164, 190, al))
    out['smoke'] = (40, [small(40, lambda cv, f=f: smoke(cv, f)) for f in range(3)])

    def scan(cv, f):
        r = 9 if f == 0 else 7
        circle(cv, 14, FX_Y, r, r, gold)
        for t in range(4):
            ang = t * np.pi / 2 + (np.pi / 4 if f else 0)
            for k in range(r - 3, r + 3):
                cv.px(14 + round(k * np.cos(ang)), FX_Y + round(k * np.sin(ang)), gold2)
        cv.px(14, FX_Y, white)
    out['scan'] = (28, [small(28, lambda cv, f=f: scan(cv, f)) for f in range(2)])

    def runes_(cv, f):
        rx = [9, 15, 20][f]
        circle(cv, 22, H - 3, rx, max(1, rx // 6), gold, phase=f, hi=white)
        if f == 2:
            circle(cv, 22, H - 3, 12, 2, gold2)
        for k in range(0, 2 * rx, 4):
            cv.px(22 - rx + k, H - 4 - (k // 4) % 2, gold2)
    out['runes'] = (44, [small(44, lambda cv, f=f: runes_(cv, f)) for f in range(3)])

    def pillar(cv, f):
        half = [1, 4, 2][f]
        k = [0.8, 1.0, 0.5][f]
        for y in range(H):
            for dx in range(-half, half + 1):
                inner = abs(dx) <= half // 2
                cv.px(10 + dx, y, (gold2 if inner else gold)[:3] + (int((255 if inner else 150) * k),))
        for n in range(3):
            sparkle(cv, 10 + (n - 1) * (half + 3), H - 6 - n * 8 - f * 2, 2, white, gold)
    out['pillar'] = (20, [small(20, lambda cv, f=f: pillar(cv, f)) for f in range(3)])

    def heal(cv, f):
        green, mint = hexc('#8dffa0'), hexc('#e0ffe6')
        for k, (dx, dy) in enumerate(((-6, 4), (5, 2), (0, -3), (-3, -8), (6, -6))):
            if (k + f) % 3 == 2:
                continue
            y = FX_Y + dy - f * 3
            cv.px(12 + dx, y, mint)
            for ddx, ddy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                cv.px(12 + dx + ddx, y + ddy, green)
    out['heal'] = (24, [small(24, lambda cv, f=f: heal(cv, f)) for f in range(3)])

    def spark(cv, f):
        c1, c2 = hexc('#ffffff'), hexc('#9fd0ff')
        r = 5 if f == 0 else 7
        for t in range(8):
            ang = t * np.pi / 4 + (0.39 if f else 0)
            for k in range(1 + f * 3, r):
                cv.px(8 + round(k * np.cos(ang)), FX_Y + round(k * np.sin(ang)), c1 if k < 3 else c2)
    out['spark'] = (16, [small(16, lambda cv, f=f: spark(cv, f)) for f in range(2)])

    def summon_circle(cv, f):
        violet, lilac = hexc('#b08cff'), hexc('#f0e6ff')
        rx = [4, 9, 14, 14][f]
        circle(cv, 18, H - 3, rx, max(1, rx // 4), violet, phase=f * 0.8, hi=lilac)
        if f >= 2:
            circle(cv, 18, H - 3, rx - 4, max(1, (rx - 4) // 4), gold)
        if f == 3:
            for y in range(H - 24, H - 3):
                for dx in (-2, -1, 0, 1, 2):
                    cv.px(18 + dx, y, gold2[:3] + (150 if abs(dx) <= 1 else 70,))
            sparkle(cv, 18, H - 26, 3, white, gold)
    out['circle'] = (36, [small(36, lambda cv, f=f: summon_circle(cv, f)) for f in range(4)])

    def poof(cv, f):
        for k, (dx, dy) in enumerate(((-8, 6), (7, 2), (0, -4), (-4, -10), (9, -8), (2, 10))):
            sparkle(cv, 16 + round(dx * (1 + f * 0.3)), FX_Y + dy - f * 2, 3 if (k + f) % 2 == 0 else 2, white, gold)
    out['poof'] = (32, [small(32, lambda cv, f=f: poof(cv, f)) for f in range(2)])
    out.update(work_fx())
    return out


# ---------- what each kind of work brings to a battle, and the camp's pastimes ----------
def rgb(h, a=255):
    return hexc(h, a)


def disc(cv, cx, cy, rx, ry, c):
    for y in range(-ry, ry + 1):
        for x in range(-rx, rx + 1):
            if (x / max(rx, 0.5)) ** 2 + (y / max(ry, 0.5)) ** 2 <= 1.0:
                cv.px(cx + x, cy + y, c)


def line(cv, x0, y0, x1, y1, c, every=1):
    n = int(round(max(abs(x1 - x0), abs(y1 - y0), 1)))
    for k in range(n + 1):
        if k % every == 0:
            cv.px(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, c)


ANVIL = ['....###########.', '##############..', '.#############..', '.....#######....', '......#####.....',
         '......#####.....', '....#########...', '...###########..']
POTION = ['..ccc..', '..ggg..', '..g.g..', '.gLLLg.', 'gLLLLLg', 'gLwLLLg', 'gLLLLLg', 'gLLLLLg', '.gLLLg.', '..ggg..']
HOURGLASS = ['wwwwwww', '.g...g.', '.g...g.', '..g.g..', '...g...', '..g.g..', '.g...g.', '.g...g.', 'wwwwwww']
QMARK = ['.###.', '#...#', '...#.', '..#..', '.....', '..#..']
EXMARK = ['#', '#', '#', '#', '.', '#']
NOTE = ['..##', '..#.', '..#.', '###.', '##..']
BUBBLE = ['.#########.', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#',
          '.##w######.', '.#w#.......', '.##........']


def work_fx():
    """key -> (width, [frames]): the anvil and forged blade (build), banner and aura (git), potion (install), meteor and
    blast (delete), footprints and lens (search), map and arrow (plan), hourglass (wait), thought bubbles, grimoire,
    shooting star, blooming flowers, butterfly, fishing rod and training dummy (the camp)"""
    gold, gold2, white = rgb('#ffd86a'), rgb('#fff2b0'), rgb('#ffffff')
    out = {}

    def make(w, n, draw):
        fr = []
        for f in range(n):
            cv = Canvas(w)
            draw(cv, f)
            fr.append(cv.out())
        return (w, fr)

    # anvil with a hot ingot: 0 glowing, 1 struck (sparks fly up), 2 sparks falling
    def anvil(cv, f):
        x0, top = 4, H - len(ANVIL)
        for j, row in enumerate(ANVIL):
            c = rgb('#c4cadc') if j == 0 else rgb('#7a8098') if j < 3 else rgb('#5a5f78') if j < 6 else rgb('#454860')
            for i, ch in enumerate(row):
                if ch == '#':
                    cv.px(x0 + i, top + j, c)
        for i in range(6):
            cv.px(x0 + 6 + i, top - 1, rgb('#ffe2a0') if f == 1 else rgb('#ffb050'))
            cv.px(x0 + 6 + i, top - 2, rgb('#ff8a3a') if i in (0, 5) else rgb('#ffd27a'))
        sx, sy = x0 + 9, top - 3
        if f == 1:
            for k in range(8):
                a = -np.pi * (0.1 + 0.8 * k / 7)
                for r in (2, 4, 6):
                    cv.px(sx + r * np.cos(a), sy + r * np.sin(a) * 1.3, white if r < 4 else gold)
        elif f == 2:
            for k, (dx, dy) in enumerate(((-7, -4), (6, -6), (-4, -9), (8, -2), (2, -11), (-9, 0))):
                cv.px(sx + dx, sy + dy, gold if k % 2 else gold2)
    out['anvil'] = make(24, 3, anvil)

    # a forged greatsword, point down, glowing
    def blade(cv, f):
        cx = 6
        glow = rgb('#ffe27a', 150 if f == 0 else 230)
        for y in range(8, 26):
            cv.px(cx - 2, y, glow)
            cv.px(cx + 2, y, glow)
        for y in range(8, 25):
            cv.px(cx - 1, y, rgb('#c8d4ea'))
            cv.px(cx, y, white)
            cv.px(cx + 1, y, rgb('#9aa8c8'))
        cv.px(cx, 25, white)
        cv.px(cx, 26, rgb('#c8d4ea'))
        for x in range(cx - 4, cx + 5):
            cv.px(x, 7, gold)
        for y in range(3, 7):
            cv.px(cx, y, rgb('#8a5a30'))
        cv.px(cx, 2, gold)
        cv.px(cx - 1, 2, gold2)
        if f:
            for k, (dx, dy) in enumerate(((-4, 12), (4, 17), (-3, 22))):
                sparkle(cv, cx + dx, dy, 2, white, gold)
    out['blade'] = make(12, 2, blade)

    # the party's banner, waving
    def banner(cv, f):
        px_ = 3
        for y in range(4, H):
            cv.px(px_, y, rgb('#8a5a30'))
            cv.px(px_ + 1, y, rgb('#5e3a1c'))
        sparkle(cv, px_, 3, 2, gold2, gold)
        for x in range(px_ + 2, px_ + 14):
            k = x - px_ - 2
            dy = round(np.sin(k * 0.55 + f * np.pi) * 1.2)
            depth = 10 - (1 if k > 9 and f else 0)
            for y in range(depth):
                notch = k >= 11 and 3 <= y <= 6
                if notch:
                    continue
                c = rgb('#ffd86a') if y == depth - 1 else rgb('#3c64c8') if (k + y) % 5 else rgb('#4a74da')
                cv.px(x, 5 + y + dy, c)
            if 3 <= k <= 6:
                for y in (3, 4, 5):
                    if abs(k - 4.5) + abs(y - 4) <= 2:
                        cv.px(x, 5 + y + dy, gold2)
    out['banner'] = make(18, 2, banner)

    # a golden aura (strength up): a ring on the ground, motes rising
    def aura(cv, f):
        cx = 14
        circle(cv, cx, H - 2, 10, 2, rgb('#ffd86a', 200), phase=f * 1.2, hi=white)
        for k, (dx, base) in enumerate(((-8, 4), (-4, 10), (0, 2), (5, 8), (9, 14), (-10, 16), (3, 18))):
            y = H - 4 - (base + f * 5) % 24
            c = rgb('#fff2b0', 220) if k % 2 else rgb('#ffc040', 200)
            cv.px(cx + dx, y, c)
            cv.px(cx + dx, y + 1, (c[0], c[1], c[2], 90))
        for x in (cx - 11, cx + 11):
            for y in range(H - 12 + f * 2, H - 2):
                cv.px(x, y, rgb('#ffe27a', 60))
    out['aura'] = make(28, 3, aura)

    # a potion bottle (bubbling)
    def potion(cv, f):
        cmap = {'c': rgb('#9a6a3a'), 'g': rgb('#d8ecff', 220), 'L': rgb('#ff5a8c'), 'w': white}
        cv.bitmap(POTION, 1, 3, cmap)
        if f:
            for dx, dy in ((2, 1), (5, 0), (3, -1)):
                cv.px(1 + dx, 3 + dy, rgb('#ffb0cc', 200))
            sparkle(cv, 7, 4, 2, white, rgb('#ff9ac0'))
    out['potion'] = make(10, 2, potion)

    # a meteor falling down to the right (from the party's side), its fiery tail behind (up left)
    def meteor(cv, f):
        hx, hy = 15, 24
        for k in range(1, 15):
            r = max(0, 3 - k // 4)
            x, y = hx - k, hy - k
            c = FLAME[min(3, k // 4)]
            if (k + f) % 5 == 0 and k > 6:
                continue
            disc(cv, x, y, r, r, c)
        disc(cv, hx, hy, 3, 3, rgb('#6a3020'))
        cv.px(hx + 1, hy - 1, rgb('#ffb050'))
        cv.px(hx - 1, hy, rgb('#ff7a30'))
        cv.px(hx, hy + 1, rgb('#ffcf70') if f else rgb('#ff7a30'))
    out['meteor'] = make(22, 2, meteor)

    # a big explosion on the ground: flash, fireball, smoke
    def blast(cv, f):
        cx, by = 22, H - 1
        if f == 0:
            disc(cv, cx, by - 4, 9, 7, rgb('#fff6c0'))
            disc(cv, cx, by - 4, 5, 4, white)
            for k in range(10):
                a = np.pi * (1 + k / 9)
                line(cv, cx + 10 * np.cos(a), by - 4 + 9 * np.sin(a), cx + 16 * np.cos(a), by - 4 + 15 * np.sin(a), rgb('#ffd86a'))
        elif f == 1:
            disc(cv, cx, by - 9, 15, 10, rgb('#c2381c'))
            disc(cv, cx, by - 9, 12, 8, rgb('#f2702a'))
            disc(cv, cx, by - 10, 8, 6, rgb('#ffc23c'))
            disc(cv, cx, by - 10, 4, 3, rgb('#fff4b0'))
            for dx in (-10, -3, 5, 11):
                disc(cv, cx + dx, by - 19 + abs(dx) // 4, 3, 2, rgb('#5a4a5c', 220))
        else:
            for k, (dx, dy, r) in enumerate(((-12, -6, 4), (-5, -12, 5), (4, -14, 5), (12, -7, 4), (0, -4, 4))):
                disc(cv, cx + dx, by + dy, r, r - 1, rgb('#8a8098', 170))
                disc(cv, cx + dx - 1, by + dy - 1, r - 2, r - 2, rgb('#b8b0c4', 150))
            for dx, dy in ((-15, -2), (14, -4), (-7, -18), (9, -20)):
                cv.px(cx + dx, by + dy, rgb('#ffb050'))
    out['blast'] = make(44, 3, blast)

    # footprints on the ground
    def prints(cv, f):
        dark, lit = rgb('#2a1c14', 220), rgb('#f0e0b0', 200)
        for x, y in ((1, H - 2), (6, H - 4)):
            for dx in range(3):
                cv.px(x + dx, y, dark)
                cv.px(x + dx, y + 1, lit)
            cv.px(x + 3, y, (dark[0], dark[1], dark[2], 140))
    out['prints'] = make(10, 1, prints)

    # a magnifying glass (searching)
    def lens(cv, f):
        cx, cy = 7, 13
        disc(cv, cx, cy, 4, 4, rgb('#bfe6ff', 90))
        circle(cv, cx, cy, 5, 5, rgb('#d8a850'))
        circle(cv, cx, cy, 6, 6, rgb('#7a5420', 160))
        for k in range(5):
            cv.px(cx + 4 + k, cy + 4 + k, rgb('#6a3a1c'))
            cv.px(cx + 5 + k, cy + 4 + k, rgb('#8a5a30'))
        if f:
            cv.px(cx - 2, cy - 2, white)
            cv.px(cx - 1, cy - 3, white)
            sparkle(cv, cx + 3, cy - 6, 2, white, gold)
    out['lens'] = make(18, 2, lens)

    # thought bubbles: ? ! … and a note (humming)
    def bubble(cv, f):
        cv.bitmap(BUBBLE, 0, 0, {'#': rgb('#2a1a3a'), 'w': rgb('#fffaf0')})
        if f == 0:
            cv.bitmap(QMARK, 3, 1, {'#': rgb('#3a5ad8')})
        elif f == 1:
            cv.bitmap(EXMARK, 5, 1, {'#': rgb('#ff4a3d')})
        elif f == 2:
            for x in (2, 5, 8):
                cv.px(x, 4, rgb('#2a1a3a'))
        else:
            cv.bitmap(NOTE, 3, 1, {'#': rgb('#c03a8a')})
    out['bubble'] = make(12, 4, bubble)

    # a map scroll unrolling: rolled, half open, open with a route and an X
    def map_(cv, f):
        paper, edge, roll = rgb('#efe0b8'), rgb('#c8a870'), rgb('#9a7448')
        w = [2, 12, 24][f]
        x0, y0, h = 15 - w // 2, 4, 11
        for x in range(x0, x0 + w):
            for y in range(y0, y0 + h):
                cv.px(x, y, edge if y in (y0, y0 + h - 1) else paper)
        for x in (x0 - 2, x0 + w):
            for y in range(y0 - 1, y0 + h + 1):
                cv.px(x, y, roll)
                cv.px(x + 1, y, rgb('#b88c58'))
        if f == 2:
            pts = [(x0 + 2, y0 + 8), (x0 + 6, y0 + 7), (x0 + 9, y0 + 5), (x0 + 13, y0 + 6), (x0 + 17, y0 + 3)]
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                line(cv, ax, ay, bx, by, rgb('#c0402a'), every=2)
            ex, ey = x0 + 19, y0 + 2
            for d in (-1, 0, 1):
                cv.px(ex + d, ey + d, rgb('#e02020'))
                cv.px(ex + d, ey - d, rgb('#e02020'))
            for tx in (x0 + 4, x0 + 12):
                cv.px(tx, y0 + 3, rgb('#4a8a4a'))
                cv.px(tx - 1, y0 + 4, rgb('#4a8a4a'))
                cv.px(tx + 1, y0 + 4, rgb('#4a8a4a'))
    out['map'] = make(30, 3, map_)

    # a tactical arrow drawn on the ground, pointing at the monster (blinking)
    def arrow(cv, f):
        a = 210 if f == 0 else 110
        body, core = rgb('#ff7a50', a), rgb('#ffe0a0', a)
        for x in range(1, 18):
            cv.px(x, H - 3, body)
            cv.px(x, H - 2, core if x % 3 else body)
        for k in range(6):  # the head, flattened like the shaft (it lies on the ground)
            half = 5 - k
            for dy in range(-half, half + 1):
                cv.px(18 + k, H - 2.5 + dy * 0.5, core if abs(dy) < half - 1 else body)
    out['arrow'] = make(26, 2, arrow)

    # an hourglass, its sand running down
    def hourglass(cv, f):
        cv.bitmap(HOURGLASS, 1, 2, {'w': rgb('#9a6a3a'), 'g': rgb('#d8ecff', 200)})
        sand = rgb('#ffd27a')
        top = [[(3, 4), (4, 4), (5, 4), (3, 5), (4, 5), (5, 5), (4, 6)], [(4, 5), (3, 5), (5, 5), (4, 6)], [(4, 6)]][f]
        bot = [[(4, 9)], [(4, 9), (3, 9), (5, 9), (4, 8)], [(3, 8), (4, 8), (5, 8), (2, 9), (3, 9), (4, 9), (5, 9), (6, 9), (4, 7)]][f]
        for x, y in top + bot:
            cv.px(x + 1, y + 1, sand)
        if f < 2:
            cv.px(5, 7 + 1, sand)
            cv.px(5, 8 + 1, rgb('#ffd27a', 150))
    out['hourglass'] = make(10, 3, hourglass)

    # an open grimoire floating, pages turning, sparkles
    def grimoire(cv, f):
        cx, y0 = 9, 9
        cover, page, ink = rgb('#6a3fa0'), rgb('#fff6e0'), rgb('#b0a080')
        for x in range(cx - 7, cx + 8):
            cv.px(x, y0 + 6, cover)
        for k, side in enumerate((-1, 1)):
            for i in range(1, 7):
                x = cx + side * i
                lift = 1 if i > 3 else 0
                for y in range(y0 + lift, y0 + 6):
                    cv.px(x, y, page)
                if i in (2, 4, 6):
                    cv.px(x, y0 + 2 + lift, ink)
                    cv.px(x, y0 + 4, ink)
        cv.px(cx, y0, cover)
        for y in range(y0, y0 + 6):
            cv.px(cx, y, rgb('#d8c8a0'))
        if f:
            for y in range(y0 - 3, y0 + 4):
                cv.px(cx + 3 - (y0 - y) // 2, y, page)
        for k, (dx, dy) in enumerate(((-6, -4), (5, -6), (0, -8))):
            sparkle(cv, cx + dx, y0 + dy + (f if k % 2 else -f), 2 if (k + f) % 2 else 1, white, gold)
    out['grimoire'] = make(20, 2, grimoire)

    # a shooting star crossing the sky right to left
    def star(cv, f):
        hx, hy = 40 - f * 16, 3 + f * 4
        for k in range(1, 10):
            cv.px(hx + k, hy - k * 0.4, rgb('#fff6c0', max(30, 220 - k * 22)))
        sparkle(cv, hx, hy, 2 if f < 2 else 1, white, rgb('#fff2b0'))
    out['star'] = make(48, 3, star)

    # a patch of flowers coming into bloom
    pet = [rgb('#ff9ad6'), white, rgb('#a6c8ff'), rgb('#ffd0e8'), rgb('#c8b4ff'), rgb('#ffe27a')]
    spots = [(3, 29), (9, 27), (15, 30), (21, 28), (27, 29), (33, 27), (39, 30), (6, 24), (18, 25), (30, 24), (36, 25), (12, 31)]

    def bloom(cv, f):
        for k, (x, y) in enumerate(spots):
            anim.flower(cv, x, y, pet[k % len(pet)], min(3, max(1, f + 1 - k % 3)))
        if f == 3:
            sparkle(cv, 24, 20, 2, white, gold)
    out['bloom'] = make(42, 4, bloom)

    def butterfly(cv, f):
        c, d = rgb('#ffb0e0'), rgb('#ff70b8')
        if f == 0:
            for dx, dy in ((-2, -1), (-1, -1), (-2, 0), (1, -1), (2, -1), (2, 0)):
                cv.px(4 + dx, 10 + dy, c)
        else:
            for dx, dy in ((-1, -2), (-1, -1), (1, -2), (1, -1)):
                cv.px(4 + dx, 10 + dy, d)
        cv.px(4, 10, rgb('#3a2a3a'))
        cv.px(4, 11, rgb('#3a2a3a'))
    out['butterfly'] = make(8, 2, butterfly)

    # a fishing rod held out over the water: the float bobs, rings spread, a bite (splash)
    def rod(cv, f):
        brown, line_c = rgb('#7a4a24'), rgb('#e8eef8', 150)
        line(cv, 0, 20, 16, 4, brown)
        line(cv, 1, 20, 17, 4, rgb('#a06a3a'))
        bx, by = 30, H - 3 + (1 if f == 3 else 0)
        for k in range(15):
            t = k / 14
            cv.px(17 + (bx - 17) * t, 4 + (by - 4) * t ** 1.6, line_c)
        if f != 3:
            cv.px(bx, by - 1 - (f == 1), rgb('#ff4a3d'))
            cv.px(bx, by - (f == 1), white)
        if f in (1, 2):
            circle(cv, bx, by + 1, 3 + f, 1, rgb('#d0eaff', 150 if f == 1 else 90))
        if f == 3:
            for dx, dy in ((-3, -3), (3, -4), (-1, -5), (2, -2)):
                cv.px(bx + dx, by + dy, rgb('#bfe6ff'))
            circle(cv, bx, by, 4, 1, rgb('#d0eaff', 180))
    out['rod'] = make(36, 4, rod)

    # a straw training dummy (wobbles when hit)
    def dummy(cv, f):
        lean = 2 if f else 0
        wood, straw, burlap = rgb('#6a4424'), rgb('#e0c070'), rgb('#c8a878')
        for y in range(20, H):
            cv.px(8, y, wood)
        for y in range(12, 20):
            cv.px(8 + lean * (20 - y) / 8, y, wood)
        disc(cv, 8 + lean, 16, 4, 4, straw)
        for x in range(2, 15):
            cv.px(x + lean, 14, wood)
        disc(cv, 8 + lean * 1.5, 9, 3, 3, burlap)
        cv.px(7 + lean * 1.5, 9, rgb('#3a2a20'))
        cv.px(9 + lean * 1.5, 9, rgb('#3a2a20'))
        if f:
            for dx, dy in ((-5, 14), (6, 12), (-3, 9), (7, 18)):
                cv.px(8 + dx, dy, straw)
    out['dummy'] = make(16, 2, dummy)
    return out


# ---------- props ----------
FLAME = [hexc('#fff4b0'), hexc('#ffc23c'), hexc('#f2702a'), hexc('#c2381c')]


def flames(cv, cx, base, f, height):
    """a flickering fire: rows from the base up, narrowing, colors from the core out"""
    shapes = [[5, 5, 4, 4, 3, 2, 1, 1, 0], [5, 4, 4, 3, 3, 2, 2, 1, 0], [5, 5, 4, 3, 2, 2, 1, 0, 0], [5, 4, 4, 4, 3, 2, 1, 1, 1]]
    sway = [[0, 0, 0, 1, 1, 1, 1, 2, 0], [0, 0, -1, -1, -1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, -1, 0, 0], [0, 0, 0, -1, 0, 1, 1, 1, 1]]
    rows = shapes[f % 4][:height]
    for r, half in enumerate(rows):
        y = base - r
        s = sway[f % 4][r] if r < len(sway[f % 4]) else 0
        for dx in range(-half, half + 1):
            d = abs(dx) / max(1, half)
            c = FLAME[0] if d < 0.34 and r < height - 2 else FLAME[1] if d < 0.67 else FLAME[2]
            if r >= height - 2:
                c = FLAME[2] if d < 0.5 else FLAME[3]
            cv.px(cx + dx + s, y, c)
    for k, (sx, sy) in enumerate(((-2, 2), (2, 4), (0, 6), (-1, 8))):
        if (f + k) % 4 == 0:
            cv.px(cx + sx, base - height - sy + 4, FLAME[1])


def steam(cv, cx, top, f):
    c = (235, 235, 245, 150)
    for k in range(3):
        t = (f + k * 2) % 6
        y = top - t * 2
        x = cx - 3 + k * 3 + (1 if (t // 2) % 2 else 0)
        cv.px(x, y, c)
        cv.px(x, y - 1, (235, 235, 245, 90))


def props_glyphs(P):
    """name -> (ms, [frames], width)"""
    out = {}
    logs, pot = P['logs'], P['pot']
    W = 24
    lx = (W - logs.shape[1]) // 2

    def fire(f, height):
        cv = Canvas(W)
        put(cv, logs, lx, H - logs.shape[0])
        flames(cv, W // 2, H - logs.shape[0] + 3, f, height)
        return cv.out()
    out['fire'] = (140, [fire(f, 8) for f in range(4)], W)

    def embers(f):
        cv = Canvas(W)
        put(cv, logs, lx, H - logs.shape[0])
        flames(cv, W // 2, H - logs.shape[0] + 3, f, 3)
        for k, (ex, ey) in enumerate(((-4, 3), (3, 5), (0, 8))):
            if (f + k) % 3 == 0:
                cv.px(W // 2 + ex, H - logs.shape[0] - ey, (255, 150, 60, 200))
        return cv.out()
    out['embers'] = (300, [embers(f) for f in range(4)], W)

    PW = max(W, pot.shape[1] + 2)
    px_ = (PW - pot.shape[1]) // 2

    def cook(f):
        cv = Canvas(PW)
        put(cv, logs, (PW - logs.shape[1]) // 2, H - logs.shape[0])
        flames(cv, PW // 2, H - logs.shape[0] + 3, f, 5)
        put(cv, pot, px_, H - pot.shape[0])
        col = pot[:, pot.shape[1] // 2, 3] > 0
        rows = np.nonzero(col)[0]
        gap = [r for r in range(1, len(col)) if col[r] and not col[r - 1]]
        top = H - pot.shape[0] + (gap[-1] if gap else rows[0])
        steam(cv, PW // 2, top - 2, f)
        return cv.out()
    out['cook'] = (180, [cook(f) for f in range(4)], PW)

    for name in ('tent', 'chest', 'bedroll', 'signpost', 'backpack'):
        s = P[name]
        cv = Canvas(s.shape[1])
        put(cv, s, 0, H - s.shape[0])
        out[name] = (1000, [cv.out()], s.shape[1])

    co = P['chest_open']
    CW = co.shape[1] + 8

    def treasure(f):
        cv = Canvas(CW)
        ground_shadow(cv, 4, co.shape[1], 70)
        put(cv, co, 4, H - co.shape[0])
        for k, (sx, sy) in enumerate(((2, 6), (CW - 3, 9), (CW // 2, 1), (5, 14))):
            sparkle(cv, sx, H - co.shape[0] + sy - 4, 3 if (f + k) % 4 == 0 else 2 if (f + k) % 4 == 1 else 0,
                    hexc('#ffffff'), hexc('#ffe27a', 220))
        return cv.out()
    out['treasure'] = (200, [treasure(f) for f in range(4)], CW)

    def ring(f):
        cv = Canvas(22)
        c = hexc('#ffd36a', 230 if f == 0 else 120)
        for dx in range(3, 19):
            cv.px(dx, H - 1, c)
        for dx in (1, 2, 19, 20):
            cv.px(dx, H - 2, c)
        for dx in range(3, 19):
            cv.px(dx, H - 3, (c[0], c[1], c[2], c[3] // 2))
        return cv.out()
    out['ring'] = (500, [ring(f) for f in range(2)], 22)
    return out


# ---------- a COLR font of many glyphs, each its own width ----------
def build_font(path, family, glyphs):
    """glyphs: list of (codepoint, width, rgba frame)"""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.colorLib.builder import buildCOLR, buildCPAL
    import colrfont
    U = colrfont.U
    allpx = np.concatenate([f[f[..., 3] > 0].reshape(-1, 4) for _, _, f in glyphs])
    allpx[:, 3] = (np.round(allpx[:, 3] / 17) * 17).astype(np.uint8)
    pal = np.unique(allpx, axis=0)
    if len(pal) > 255:
        rgb = Image.fromarray(allpx[:, :3].reshape(1, -1, 3))
        q = rgb.quantize(colors=220, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        qp = np.array(q.getpalette()[:660]).reshape(-1, 3)
        allpx[:, :3] = qp[np.asarray(q).ravel()]
        pal = np.unique(allpx, axis=0)
    lut = {tuple(c): i for i, c in enumerate(pal)}
    UPM = H * U
    names = ['.notdef', 'space']
    gl = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}
    metrics = {'.notdef': (8 * U, 0), 'space': (8 * U, 0)}
    cmap = {0x20: 'space'}
    layers = {}
    for cp, w, f in glyphs:
        cells = {}
        ys, xs = np.nonzero(f[..., 3] > 0)
        for y, x in zip(ys, xs):
            c = f[y, x].copy()
            c[3] = np.uint8(round(c[3] / 17) * 17)
            key = tuple(c)
            if key not in lut:
                key = tuple(pal[((pal.astype(int) - c.astype(int)) ** 2).sum(1).argmin()])
            cells.setdefault(lut[key], set()).add((int(x), int(y)))
        base = f'g{cp:04X}'
        names.append(base)
        cmap[cp] = base
        metrics[base] = (w * U, 0)
        lay, allc = [], set()
        for ci, cs in sorted(cells.items()):
            ln = f'{base}_{ci}'
            gl[ln] = colrfont.rects_glyph(cs, H)
            names.append(ln)
            metrics[ln] = (w * U, 0)
            lay.append((ln, ci))
            allc |= cs
        gl[base] = colrfont.rects_glyph(allc, H) if allc else TTGlyphPen(None).glyph()
        layers[base] = lay
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(gl)
    glyf = fb.font['glyf']
    for n in names:
        g = glyf[n]
        g.recalcBounds(glyf)
        metrics[n] = (metrics[n][0], getattr(g, 'xMin', 0) if g.numberOfContours else 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    ps = family.replace(' ', '')
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': ps + '-Regular',
                       'fullName': family + ' Regular', 'psName': ps + '-Regular', 'version': 'Version 1.000'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0, fsType=0)
    fb.setupPost()
    fb.font['COLR'] = buildCOLR(layers)
    fb.font['CPAL'] = buildCPAL([[tuple(c / 255 for c in col[:3]) + (col[3] / 255,) for col in pal]])
    fb.save(path)


class Glyphs:
    """code points handed out in order, for one font"""
    def __init__(self, start=0xE000):
        self.cp, self.list = start, []

    def add(self, w, frames):
        cps = list(range(self.cp, self.cp + len(frames)))
        self.list += [(c, w, f) for c, f in zip(cps, frames)]
        self.cp += len(frames)
        return cps


def main(home, atlas=None):
    party = f'{home}/mods/pixel-party'
    os.makedirs(f'{party}/scenes', exist_ok=True)
    for sc in SCENES:
        band(home, sc).resize((STRIP_W * 2, SH * 2), Image.NEAREST).save(f'{party}/scenes/{sc}.png')
    M = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/monsters.npz').items()}
    P = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/props.npz').items()}
    fonts = {}

    g, mon = Glyphs(), {}
    for n, (title, hover, bob, kind) in MONSTERS.items():
        fr, geo = monster_frames(M[n], hover, bob)
        mon[n] = {'name': title, 'kind': kind, **geo, **{k: g.add(MW, fr[k]) for k in ('idle', 'hurt', 'attack', 'spawn')}}
    fonts['monsters'] = g.list

    fx, g = fx_glyphs(), Glyphs()
    fxs = {'num': {c: [g.add(NUM_ADV, row) for row in rows] for c, rows in fx['num'].items()}, 'numAdvance': NUM_ADV,
           'word': {wd: {'w': w, 'cps': g.add(w, fr)} for wd, (w, fr) in fx['word'].items()},
           'mon': {k: {part: {'w': w, 'cps': g.add(w, fr)} for part, (w, fr) in v.items()} for k, v in fx['mon'].items()}}
    for key in ('hp', 'smoke', 'scan', 'runes', 'pillar', 'heal', 'spark', 'circle', 'poof', 'anvil', 'blade', 'banner',
                'aura', 'potion', 'meteor', 'blast', 'prints', 'lens', 'bubble', 'map', 'arrow', 'hourglass', 'grimoire',
                'star', 'bloom', 'butterfly', 'rod', 'dummy'):
        w, fr = fx[key]
        fxs[key] = {'w': w, 'cps': g.add(w, fr)}
    fxs['y'] = FX_Y
    fxs['numTop'] = NUM_TOP
    fonts['fx'] = g.list

    g, props = Glyphs(), {}
    for n, (ms, fr, w) in props_glyphs(P).items():
        props[n] = {'ms': ms, 'w': w, 'cps': g.add(w, fr)}
    fonts['props'] = g.list

    # specials (필살기), the long battle's banners, the dimming and the SP gauge: a font of their own
    sp, g = special_art.special_glyphs(), Glyphs()
    sps = {k: {'w': sp[k][0], 'cps': g.add(*sp[k])} for k in ('shade', 'shadeTop', 'gauge', 'shock')}
    sps['title'] = {wd: {'w': w, 'cps': g.add(w, fr)} for wd, (w, fr) in sp['title'].items()}
    sps['chars'] = {cid: {k: {'w': w, 'cps': g.add(w, fr)} for k, (w, fr) in own.items()} for cid, own in sp['chars'].items()}
    sps['moves'] = {cid: {'name': n, 'how': how} for cid, (n, how) in special_art.SPECIAL.items()}
    fonts['special'] = g.list

    for key, gl in fonts.items():
        # a font Herdr already loaded keeps its name (it keeps the family in memory): rewrite only what changed
        path = f'{party}/fonts/FrierenDot{V}-{key}.ttf'
        build_font(path + '.new', f'FrierenDot{V} {key.capitalize()}', gl)
        anim.colrfont.mac_layers(path + '.new')  # writes <path>.layers.json too (see colrfont.mac_layers)
        if os.path.exists(path) and open(path, 'rb').read() == open(path + '.new', 'rb').read():
            os.remove(path + '.new')
        else:
            os.replace(path + '.new', path)
            print('wrote', os.path.basename(path))
        if atlas:
            np.savez_compressed(f'{atlas}/atlas_{key}.npz', **{f'{cp:x}': f for cp, _, f in gl})

    chars, cp, battle = {}, anim.BATTLE_BASE, {}
    for name in anim.NAMES:
        poses, anchors = anim.load(name, f'{HERE}/spr')
        chars[name] = {'tip': list(anim.tip(poses, anchors)), 'style': anim.MAGIC[name][0]}
    for key, w, n in anim.BATTLE:
        battle[key] = {'w': w, 'cps': list(range(cp, cp + n))}
        cp += n
    spec = {
        'version': V, 'height': SH, 'glyphHeight': H, 'spriteTop': SH - H, 'sx': anim.SX, 'stageWidth': anim.STAGE_W,
        'stripWidth': STRIP_W, 'anchor': {sc: v[4] for sc, v in SCENES.items()},
        'scenes': {sc: v[3] for sc, v in SCENES.items()}, 'boss': 'golem', 'monsterWidth': MW,
        'monsters': mon, 'fx': fxs, 'props': props, 'battle': battle, 'chars': chars, 'sp': sps,
    }
    js = ('// Generated by mods/pixel-party/build/stage_art.py: the battle stage (pixel-pane\'s stage block): the strip of each\n'
          '// background (mods/pixel-party/scenes/<scene>.png), the monster, fx and prop glyphs (FrierenDot<v> Monsters / Fx /\n'
          '// Props), the characters\' battle glyphs (anim.py BATTLE) and attack tips. Sizes in art pixels (shown at 2x).\n'
          f'export const STAGE = {json.dumps(spec, separators=(",", ":"))};\n')
    with open(f'{home}/mods/pixel-pane/stage.js', 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(js)
    print('strips', len(SCENES), '| glyphs', {k: len(v) for k, v in fonts.items()})


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
