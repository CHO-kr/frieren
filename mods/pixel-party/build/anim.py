"""Compose per-character pixel animations (pose sprites + procedural magic effects) into COLR fonts.

usage: python anim.py <spr_dir> <fonts_out_dir> <faces_out_dir> <manifest.json> [preview_dir]
"""
import sys, os, json
import numpy as np
from PIL import Image
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import colrfont

NAMES = ['frieren', 'fern', 'stark', 'himmel', 'heiter', 'eisen', 'sein', 'ubel', 'land', 'denken', 'methode',
         'flamme', 'serie', 'kanne', 'lawine', 'wirbel']
FONT_VERSION = 4  # bump on every rebuild: Herdr keeps a loaded family in memory, a new name makes it load the new file
FAMILY = {n: f'FrierenDot{FONT_VERSION} ' + n.capitalize() for n in NAMES}

# magic per character: style (bolt | slash | holy) and colors (core, glow, deep)
MAGIC = {
    'frieren': ('bolt', '#ffffff', '#bfaaff', '#6a4fe0'),
    'fern': ('bolt', '#f6ecff', '#c690ff', '#7b3fd6'),
    'stark': ('slash', '#fff4dc', '#ffb24a', '#d4621c'),
    'himmel': ('slash', '#ffffff', '#a6dcff', '#3b7fe0'),
    'heiter': ('holy', '#fffbe2', '#ffe27a', '#d6a21c'),
    'eisen': ('slash', '#fff4dc', '#ffb24a', '#d4621c'),
    'sein': ('holy', '#fffbe2', '#ffe27a', '#d6a21c'),
    'ubel': ('slash', '#efffef', '#8fe7a0', '#2f9e55'),
    'land': ('bolt', '#eafffb', '#80e3d3', '#279c8e'),
    'denken': ('bolt', '#fff2d2', '#ff9d5c', '#d8452a'),
    'methode': ('bolt', '#fff0fa', '#ff9ad6', '#c2489a'),
    'flamme': ('bolt', '#fff5d8', '#ffc25c', '#e0622a'),
    'serie': ('bolt', '#fffbe6', '#ffd86a', '#c99a2e'),
    'kanne': ('bolt', '#eaf7ff', '#7cc4ff', '#2f74d0'),
    'lawine': ('bolt', '#f2ffff', '#a8f2ff', '#4cb6d8'),
    'wirbel': ('bolt', '#ffffff', '#cbd5e8', '#7d8aa8'),
}

H = 32          # stage rows (art pixels); shown at 2x = 64 px
STAGE_W = 80    # the session-header stage
SOLO_W = 36     # the party-card stage
SX = 16         # x of the character's head centre
STAGE_BASE, SOLO_BASE = 0xE000, 0xE400
# The session header's scene (scene_art.py): a 256-wide strip of the background, the party standing at SLOTS (head
# centres) and a monster whose left edge is at HIT_X. A spell cast there flies all the way to the monster, so each
# slot has its own cast glyphs (SCENE_BASE + slot * 12 + frame), 256 wide, drawn where they stand.
SCENE_W, SCENE_BASE = 256, 0xE800
SLOTS = [22, 48, 74, 100]
HIT_X = 184
FLIPPED = {'rest_l', 'eat_l', 'stand_l', 'alert_l'}  # facing left (the far side of the campfire)


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


class Canvas:
    def __init__(self, w):
        self.w = w
        self.a = np.zeros((H, w, 4), np.float32)

    def px(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < H:
            r, g, b, al = c
            al /= 255.0
            d = self.a[y, x]
            da = d[3]
            oa = al + da * (1 - al)
            if oa <= 0:
                return
            for i, v in enumerate((r, g, b)):
                d[i] = (v * al + d[i] * da * (1 - al)) / oa
            d[3] = oa

    def blit(self, spr, x, y):
        h, w = spr.shape[:2]
        for j in range(h):
            for i in range(w):
                if spr[j, i, 3] > 0:
                    self.px(x + i, y + j, tuple(int(v) for v in spr[j, i]))

    def bitmap(self, rows, x, y, cmap):
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch in cmap:
                    self.px(x + i, y + j, cmap[ch])

    def out(self):
        o = np.clip(self.a, 0, 255)
        o[..., 3] = np.clip(self.a[..., 3] * 255, 0, 255)
        return o.round().astype(np.uint8)


# ---------- effects ----------
def sparkle(cv, x, y, size, c, glow=None):
    if size <= 0:
        return
    cv.px(x, y, c)
    if size >= 2:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cv.px(x + dx, y + dy, glow or c)
    if size >= 3:
        for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
            cv.px(x + dx, y + dy, glow or c)


def bolt(cv, x0, x1, y, m):
    # Zoltraak-like beam: white core, coloured glow, flickering deep edge
    core, glow, deep = hexc(m[1]), hexc(m[2], 230), hexc(m[3], 170)
    for x in range(int(x0), int(x1)):
        cv.px(x, y, core)
        cv.px(x, y - 1, core if x > x0 + 2 else glow)
        cv.px(x, y + 1, glow)
        cv.px(x, y - 2, glow)
        if (x - x0) % 2 == 0:
            cv.px(x, y + 2, deep)
        if (x - x0) % 4 == 1:
            cv.px(x, y - 3, deep)
            cv.px(x, y + 3, (deep[0], deep[1], deep[2], 100))
    # bright head
    for dy in range(-3, 4):
        cv.px(x1, y + dy, core if abs(dy) < 2 else glow)
    for dy in range(-2, 3):
        cv.px(x1 + 1, y + dy, core if abs(dy) < 1 else glow)
    cv.px(x1 + 2, y, core)
    cv.px(x1 + 2, y - 1, glow)
    cv.px(x1 + 3, y, glow)


def slash(cv, x, y, m, big=True):
    core, glow = hexc(m[1]), hexc(m[2], 210)
    # a ")" crescent: wider in the middle
    arc = [(0, -7), (1, -6), (2, -5), (2, -4), (3, -3), (3, -2), (4, -1), (4, 0), (4, 1), (3, 2), (3, 3), (2, 4), (2, 5), (1, 6), (0, 7)]
    for dx, dy in arc:
        cv.px(x + dx, y + dy, core)
        cv.px(x + dx - 1, y + dy, glow)
        if big:
            cv.px(x + dx - 2, y + dy, hexc(m[3], 140))


def holy(cv, x, y, m, r=2):
    core, glow, deep = hexc(m[1]), hexc(m[2], 220), hexc(m[3], 150)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            d = abs(dx) + abs(dy)
            if d <= r - 1:
                cv.px(x + dx, y + dy, core)
            elif d == r:
                cv.px(x + dx, y + dy, glow)
    for t in (r + 1, r + 2):
        cv.px(x + t, y, deep)
        cv.px(x - t, y, deep)
        cv.px(x, y + t, deep)
        cv.px(x, y - t, deep)


def burst(cv, x, y, m, stage):
    core, glow, deep = hexc(m[1]), hexc(m[2], 230), hexc(m[3], 170)
    if stage == 0:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if abs(dx) + abs(dy) <= 2:
                    cv.px(x + dx, y + dy, core if abs(dx) + abs(dy) <= 1 else glow)
        for t in (3, 4, 5):
            for dx, dy in ((t, 0), (-t, 0), (0, t), (0, -t)):
                cv.px(x + dx, y + dy, glow if t < 5 else deep)
        for dx, dy in ((2, 2), (-2, 2), (2, -2), (-2, -2), (3, 3), (-3, 3), (3, -3), (-3, -3)):
            cv.px(x + dx, y + dy, deep)
    else:
        for t in np.linspace(0, 2 * np.pi, 20, endpoint=False):
            cv.px(x + round(6 * np.cos(t)), y + round(5 * np.sin(t)), glow)
        for dx, dy in ((7, 0), (-7, 0), (0, 6), (0, -6)):
            cv.px(x + dx, y + dy, core)
        cv.px(x, y, deep)


def charge(cv, x, y, m, n):
    core, glow = hexc(m[1]), hexc(m[2], 220)
    sparkle(cv, x, y, n, core, glow)


Z4 = ['####', '..#.', '.#..', '####']
Z3 = ['###', '.#.', '###']


def zzz(cv, x, y, f):
    c1, c2 = hexc('#e8e4ff'), hexc('#e8e4ff', 150)
    pts = [(0, 6, Z3, c2), (3, 2, Z4, c1)]
    for i, (dx, dy, bm, c) in enumerate(pts):
        yy = y + dy - f
        cv.bitmap(bm, x + dx + (f % 2), yy, {'#': c})


BANG = ['.#######.', '#wwwrwww#', '#wwwrwww#', '#wwwrwww#', '#wwwrwww#', '#wwwwwww#', '#wwwrwww#', '.#######.', '..#w#....', '..##.....', '..#......']


def bang(cv, x, y):
    cv.bitmap(BANG, x, y, {'#': hexc('#2a1a3a'), 'w': hexc('#fff8e8'), 'r': hexc('#ff4a3d')})


def flower(cv, x, y, petal, stage):
    centre = hexc('#ffe066')
    if stage <= 0:
        return
    if stage == 1:
        cv.px(x, y, hexc('#7fe0a0'))
        return
    cv.px(x, y, centre)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        cv.px(x + dx, y + dy, petal)
    if stage >= 3:
        for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            cv.px(x + dx, y + dy, (petal[0], petal[1], petal[2], 130))
    cv.px(x, y + 2, hexc('#4fa86a'))


def runes(cv, x, y, n, c):
    # little glowing "text" written in the air: dashes with gaps
    pattern = [3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2]
    done = 0
    xx = x
    for i, seg in enumerate(pattern):
        if done >= n:
            break
        if i % 2 == 0:
            for k in range(seg):
                if done >= n:
                    break
                cv.px(xx + k, y, c)
                if (xx + k) % 2 == 0:
                    cv.px(xx + k, y - 1, (c[0], c[1], c[2], 110))
                done += 1
        xx += seg


def circle(cv, cx, cy, rx, ry, c, phase=None, hi=None):
    pts = []
    for t in np.linspace(0, 2 * np.pi, 64, endpoint=False):
        pts.append((int(round(cx + rx * np.cos(t))), int(round(cy + ry * np.sin(t))), t))
    seen = set()
    for x, y, t in pts:
        if (x, y) in seen:
            continue
        seen.add((x, y))
        cv.px(x, y, c)
    if phase is not None:
        for k in range(3):
            t = phase + k * 2 * np.pi / 3
            cv.px(int(round(cx + rx * np.cos(t))), int(round(cy + ry * np.sin(t))), hi)


def shadow(cv, cx, w):
    for dx in range(-w // 2, w // 2 + 1):
        cv.px(cx + dx, H - 1, (10, 12, 30, 90))


# ---------- sprites ----------
def load(name, spr_dir):
    d = np.load(f'{spr_dir}/{name}.npz')
    poses = {p: d[p] for p in ['idle', 'walk', 'attack', 'read', 'write', 'sleep', 'cheer', 'alert']}
    anchors = dict(zip(['idle', 'walk', 'attack', 'read', 'write', 'sleep', 'cheer', 'alert'], d['anchors']))
    return poses, anchors


def tip_of(spr):
    a = spr[..., 3] > 0
    h, w = a.shape
    cols = np.nonzero(a[int(h * 0.15):int(h * 0.8)].any(0))[0]
    x = cols.max()
    ys = np.nonzero(a[:, x])[0]
    return int(x), int(ys.mean())


RIM = None   # no rim: the stage has a light backdrop (backdrop-*.png) so dark outlines read


def place(cv, poses, anchors, pose, dx=0, dy=0, flip=False, head=SX):
    """Draws a pose with its head centre at `head` (mirrored: at w-1-head, facing left)."""
    from scipy import ndimage
    spr = poses[pose]
    a = anchors[pose]
    if flip:
        spr = spr[:, ::-1]
        a = spr.shape[1] - 1 - a
        head = cv.w - 1 - head
    x = head - int(round(a)) + dx
    y = H - spr.shape[0] + dy
    if RIM:
        m = np.pad(spr[..., 3] > 0, 1)
        rim = ndimage.binary_dilation(m) & ~m
        for j, i in zip(*np.nonzero(rim)):
            if j - 1 + y < H - 1:
                cv.px(x + i - 1, y + j - 1, RIM)
    cv.blit(spr, x, y)
    return x, y


# ---------- animations ----------
# name -> (ms per frame, frame builder(i) -> list of draw ops)
def animations(name, poses, anchors):
    m = MAGIC[name]
    style = m[0]
    tx, ty = tip_of(poses['attack'])
    ax = SX - int(round(anchors['attack']))
    ay = H - poses['attack'].shape[0]
    TIPX, TIPY = ax + tx + 1, ay + ty
    head_top = H - poses['idle'].shape[0]
    out = {}

    def frame(w, ops, flip=False):
        cv = Canvas(w)
        shadow(cv, w - 1 - SX if flip else SX, 12)
        for op in ops:
            op(cv)
        return cv.out()

    P = lambda pose, dx=0, dy=0: (lambda cv: place(cv, poses, anchors, pose, dx, dy))
    PL = lambda pose, dx=0, dy=0: (lambda cv: place(cv, poses, anchors, pose, dx, dy, flip=True))

    # rest: asleep with z z z
    out['rest'] = (450, [[P('sleep'), (lambda cv, f=f: zzz(cv, SX + 8, head_top + 4, f))] for f in range(4)])

    # stand: idle, breathing (1px dip every other beat)
    out['stand'] = (650, [[P('idle')], [P('idle', 0, 1)]])

    # think: walking the road (dust behind, grass passing by)
    def road(cv, f, w):
        for k in range(0, w + 8, 9):
            x = (k - f * 3) % (w + 8) - 4
            cv.px(x, H - 1, (88, 150, 96, 150))
            cv.px(x + 1, H - 2, (110, 180, 110, 120))
        cv.px(SX - 6 - (f % 2), H - 2, (200, 190, 160, 110))
    out['think'] = (170, [[P('walk' if f % 2 == 0 else 'idle', 0, -(f % 2 == 0)), (lambda cv, f=f: road(cv, f, cv.w))] for f in range(4)])

    # cast: charge -> projectile -> impact (bolt for mages, slash for fighters, holy orb for priests)
    end = STAGE_W - 6
    span = end - TIPX
    steps = [TIPX + 2, TIPX + span // 4, TIPX + span // 2, TIPX + 3 * span // 4]
    def proj(cv, x):
        if style == 'bolt':
            bolt(cv, TIPX, x, TIPY, m)
        elif style == 'slash':
            slash(cv, x, TIPY, m)
        else:
            holy(cv, x, TIPY, m)
    cast = [
        [P('idle')],
        [P('attack'), (lambda cv: charge(cv, TIPX, TIPY, m, 1))],
        [P('attack'), (lambda cv: charge(cv, TIPX, TIPY, m, 2))],
        [P('attack'), (lambda cv: charge(cv, TIPX, TIPY, m, 3))],
    ] + [[P('attack'), (lambda cv, x=x: proj(cv, x))] for x in steps] + [
        [P('attack'), (lambda cv: burst(cv, end, TIPY, m, 0))],
        [P('attack', -1), (lambda cv: burst(cv, end, TIPY, m, 1))],
        [P('idle')],
        [P('idle')],
    ]
    out['cast'] = (90, cast)

    # read: open book, motes of light rising from the pages
    rx = SX - int(round(anchors['read']))
    rspr = poses['read']
    bx = rx + rspr.shape[1] - 4
    by = H - rspr.shape[0] + rspr.shape[0] // 2 - 1
    glow = hexc(m[2], 220)
    def motes(cv, f):
        for k in range(4):
            t = (f + k * 3) % 6
            x = bx - 3 + k * 3
            y = by - 1 - t * 2
            cv.px(x, y, hexc(m[1]) if t < 3 else glow)
            if t < 2:
                cv.px(x, y + 1, (glow[0], glow[1], glow[2], 120))
        sparkle(cv, bx + 7, by - 5 - (f % 3) * 2, 3 if f % 3 == 1 else 2, hexc(m[1]), glow)
        if f % 2 == 0:
            sparkle(cv, bx - 6, by - 9, 2, hexc(m[1]), glow)
    out['read'] = (220, [[P('read'), (lambda cv, f=f: motes(cv, f))] for f in range(6)])

    # write: quill writes golden runes in the air
    gold = hexc('#ffd86a')
    wx = SX - int(round(anchors['write'])) + poses['write'].shape[1] + 2
    wy = H - poses['write'].shape[0] + 8
    def write(cv, f):
        n = min(f * 4, 22)
        runes(cv, wx, wy, n, gold)
        if f >= 3:
            runes(cv, wx, wy + 4, min((f - 3) * 4, 16), gold)
        if f in (2, 4, 6):
            sparkle(cv, wx + min(f * 4, 22), wy + (0 if f < 4 else 4), 2, hexc('#fff6d0'), gold)
    out['write'] = (150, [[P('write'), (lambda cv, f=f: write(cv, f))] for f in range(8)])

    # fly: flight magic, floating with wind streaks
    lift = [0, -1, -2, -3, -2, -1]
    def wind(cv, f):
        for k, (yy, ln) in enumerate(((10, 5), (17, 3), (24, 4))):
            x0 = (SX + 18 - f * 5 + k * 9) % (cv.w + 10) - 5
            for i in range(ln):
                cv.px(x0 + i, yy, (220, 235, 255, 140))
    out['fly'] = (140, [[(lambda cv, f=f: wind(cv, f)), P('idle', 0, lift[f] - 1),
                         (lambda cv, f=f: [cv.px(SX + dx, H - 1, (200, 220, 255, 100 + 20 * (f % 2))) for dx in (-3, -1, 1, 3)])] for f in range(6)])

    # summon: magic circle on the ground, light pillar rises
    ccx = min(SX + 30, STAGE_W - 12)
    gold2 = hexc('#ffd86a')
    def summon(cv, f):
        rx_ = [3, 6, 9, 9, 9, 9, 9, 6][f]
        circle(cv, ccx, H - 3, rx_, max(1, rx_ // 4), hexc(m[2], 230), phase=f * 0.8, hi=hexc(m[1]))
        if f >= 3:
            hgt = [0, 0, 0, 6, 14, 22, 26, 10][f]
            for yy in range(H - 3 - hgt, H - 3):
                for dx in (-2, -1, 0, 1, 2):
                    al = 160 if abs(dx) <= 1 else 80
                    cv.px(ccx + dx, yy, (gold2[0], gold2[1], gold2[2], al))
        if f >= 5:
            sparkle(cv, ccx + (f % 2) * 4 - 2, H - 3 - [0, 0, 0, 0, 0, 24, 27, 12][f], 3, hexc('#ffffff'), gold2)
    out['summon'] = (130, [[P('attack' if 1 <= f <= 5 else 'idle'), (lambda cv, f=f: summon(cv, f))] for f in range(8)])

    # alert: needs the person; startled pose, "!" bubble blinks
    alert_x = SX - int(round(anchors['alert']))
    ax2 = min(alert_x + poses['alert'].shape[1] - 2, SOLO_W - 8)
    ay2 = max(0, H - poses['alert'].shape[0] - 3)
    out['alert'] = (380, [[P('alert'), (lambda cv: bang(cv, ax2, ay2))], [P('alert', 0, 1)]])

    # victory: done; jump for joy in a field of flowers (Frieren's favourite spell)
    pet = [hexc('#ff9ad6'), hexc('#ffffff'), hexc('#a6c8ff'), hexc('#ffd0e8'), hexc('#c8b4ff')]
    spots = [(SX - 9, 27), (SX + 9, 26), (SX + 14, 29), (SX - 4, 29), (SX + 20, 24), (SX + 26, 28), (SX - 11, 22), (SX + 4, 30)]
    def flowers(cv, f):
        for k, (x, y) in enumerate(spots):
            flower(cv, x, y, pet[k % len(pet)], min(3, max(0, f - k // 2)))
    out['victory'] = (170, [[(lambda cv, f=f: flowers(cv, f)), P('cheer', 0, -2 if f % 2 == 1 else 0)] for f in range(8)])

    # ---- appended for the header scene (v4); the order above must not change (lib.js ANIMS) ----
    # eat: a meal by the campfire, a speech bubble beside the head shows the food, then a heart
    def bub(cv, f, flip):
        icon = None if f == 0 else MEAT if f < 3 else HEART
        if icon:
            x = (cv.w - 1 - SX) - 6 - 11 if flip else SX + 6
            bubble(cv, x, 0, icon, flip)
    out['eat'] = (320, [[P('idle', 0, 1 if f == 2 else 0), (lambda cv, f=f: bub(cv, f, False))] for f in range(4)])
    out['eat_l'] = (320, [[PL('idle', 0, 1 if f == 2 else 0), (lambda cv, f=f: bub(cv, f, True))] for f in range(4)])
    out['rest_l'] = (450, [[PL('sleep'), (lambda cv, f=f: zzz(cv, cv.w - 1 - SX - 15, head_top + 4, f))] for f in range(4)])
    out['stand_l'] = (650, [[PL('idle')], [PL('idle', 0, 1)]])
    def bang_l(cv):
        spr_w = poses['alert'].shape[1]
        x = (cv.w - 1 - SX) - (spr_w - 1 - int(round(anchors['alert']))) - 9 + 2
        bang(cv, max(0, x), ay2)
    out['alert_l'] = (380, [[PL('alert'), bang_l], [PL('alert', 0, 1)]])

    return {k: (ms, [(lambda w, ops=ops, fl=(k in FLIPPED): frame(w, ops, fl)) for ops in frames]) for k, (ms, frames) in out.items()}


# speech bubble (11 x 9, its tail toward the head) and the icons in it (8 x 5)
BUBBLE = ['.#########.', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#', '#wwwwwwwww#',
          '.##w######.', '.#w#.......', '.##........']
MEAT = ['bb......', 'bbmmmm..', '..mhmmm.', '..mmmmMbb', '...MMM.bb']
HEART = ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...']
ICON_COLORS = {'b': '#e8dfcc', 'm': '#b0582a', 'h': '#f09a5a', 'M': '#7a3418', 'r': '#ff4f6a'}


def bubble(cv, x, y, icon, flip=False):
    rows = [r[::-1] for r in BUBBLE] if flip else BUBBLE
    cv.bitmap(rows, x, y, {'#': hexc('#2a1a3a'), 'w': hexc('#fffaf0')})
    iw = max(len(r) for r in icon)
    cv.bitmap(icon, x + 1 + (9 - iw) // 2 + (1 if iw < 9 else 0), y + 1 + (6 - len(icon)) // 2,
              {k: hexc(v) for k, v in ICON_COLORS.items()})


def scene_casts(name, poses, anchors):
    """The cast animation for each scene slot: charge, a projectile all the way to HIT_X, the burst there (frames
    9-10, when the monster flinches), 12 frames at 90 ms like 'cast'. Drawn in a SCENE_W canvas."""
    m = MAGIC[name]
    style = m[0]
    tx, ty = tip_of(poses['attack'])
    out = []
    for head in SLOTS:
        ax = head - int(round(anchors['attack']))
        ay = H - poses['attack'].shape[0]
        tipx, tipy = ax + tx + 1, ay + ty
        span = HIT_X + 2 - tipx
        steps = [tipx + 2 + span * k // 5 for k in range(1, 6)]
        A = lambda pose, dx=0, head=head: (lambda cv: place(cv, poses, anchors, pose, dx, 0, head=head))

        def proj(cv, x, tipx=tipx, tipy=tipy):
            if style == 'bolt':
                bolt(cv, tipx, x, tipy, m)
            elif style == 'slash':
                slash(cv, x, tipy, m)
            else:
                holy(cv, x, tipy, m)
        ops = [[A('idle')]] + [[A('attack'), (lambda cv, n=n, tipx=tipx, tipy=tipy: charge(cv, tipx, tipy, m, n))] for n in (1, 2, 3)]
        ops += [[A('attack'), (lambda cv, x=x, proj=proj: proj(cv, x))] for x in steps]
        ops += [[A('attack'), (lambda cv, tipy=tipy: burst(cv, HIT_X + 2, tipy, m, 0))],
                [A('attack', -1), (lambda cv, tipy=tipy: burst(cv, HIT_X + 2, tipy, m, 1))],
                [A('idle')]]

        def frame(ops, head=head):
            cv = Canvas(SCENE_W)
            shadow(cv, head, 12)
            for op in ops:
                op(cv)
            return cv.out()
        out.append([frame(o) for o in ops])
    return out


def face(poses, anchors, out_png, size_art=18, bg=(24, 34, 79, 255)):
    spr = poses['idle']
    ax = int(round(anchors['idle']))
    # head box: top rows, centred on the head
    box = np.zeros((size_art, size_art, 4), np.uint8)
    box[:] = bg
    x0 = ax - size_art // 2
    for j in range(size_art - 1):
        for i in range(size_art):
            sx, sy = x0 + i, j
            if 0 <= sx < spr.shape[1] and 0 <= sy < spr.shape[0] and spr[sy, sx, 3] > 0:
                box[j + 1, i] = spr[sy, sx]
    im = Image.fromarray(box, 'RGBA')
    im.resize((size_art * 2, size_art * 2), Image.NEAREST).save(out_png)


def build_one(args):
    name, spr_dir, fonts_dir, faces_dir, prev_dir = args
    poses, anchors = load(name, spr_dir)
    anims = animations(name, poses, anchors)
    frames, order = [], []
    for w, base in ((STAGE_W, STAGE_BASE), (SOLO_W, SOLO_BASE)):
        for k, (ms, fl) in anims.items():
            for i, f in enumerate(fl):
                frames.append((w, f(w)))
                order.append((w, k, i))
    for s, fl in enumerate(scene_casts(name, poses, anchors)):
        for i, f in enumerate(fl):
            frames.append((SCENE_W, f))
            order.append((SCENE_W, f'cast_s{s}', i))
    # palette: unique RGBA across all frames
    allpx = np.concatenate([f[f[..., 3] > 0].reshape(-1, 4) for _, f in frames])
    # snap alpha to 16 steps to keep the palette small
    allpx[:, 3] = (np.round(allpx[:, 3] / 17) * 17).astype(np.uint8)
    pal = np.unique(allpx, axis=0)
    if len(pal) > 255:
        # merge near colours: quantize rgb per alpha bucket
        rgb = Image.fromarray(allpx[:, :3].reshape(1, -1, 3))
        q = rgb.quantize(colors=200, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        qp = np.array(q.getpalette()[:600]).reshape(-1, 3)
        idx = np.asarray(q).ravel()
        allpx[:, :3] = qp[idx]
        pal = np.unique(allpx, axis=0)
    lut = {tuple(c): i for i, c in enumerate(pal)}

    def cells(f):
        d = {}
        ys, xs = np.nonzero(f[..., 3] > 0)
        for y, x in zip(ys, xs):
            c = f[y, x].copy()
            c[3] = np.uint8(round(c[3] / 17) * 17)
            key = tuple(c)
            if key not in lut:
                # nearest palette colour
                key = tuple(pal[((pal.astype(int) - c.astype(int)) ** 2).sum(1).argmin()])
            d.setdefault(lut[key], set()).add((int(x), int(y)))
        return d

    glyph_frames = []
    for (w, f) in frames:
        glyph_frames.append((w, cells(f)))
    path = f'{fonts_dir}/FrierenDot{FONT_VERSION}-{name}.ttf'
    build_font(path, FAMILY[name], glyph_frames, [tuple(int(v) for v in c) for c in pal], order)
    face(poses, anchors, f'{faces_dir}/{name}.png')
    if prev_dir:
        # preview strip of the stage frames (2x)
        st = [f for (w, f) in frames if w == STAGE_W]
        cols = 10
        rows = (len(st) + cols - 1) // cols
        pv = Image.new('RGBA', (cols * (STAGE_W + 2), rows * (H + 2)), (22, 30, 70, 255))
        for i, f in enumerate(st):
            pv.alpha_composite(Image.fromarray(f, 'RGBA'), ((i % cols) * (STAGE_W + 2), (i // cols) * (H + 2)))
        pv.resize((pv.width * 2, pv.height * 2), Image.NEAREST).save(f'{prev_dir}/{name}_anim.png')
    return name, len(frames), len(pal)


def build_font(path, family, glyph_frames, palette, order):
    """like colrfont.build but with per-glyph widths and two codepoint ranges"""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.colorLib.builder import buildCOLR, buildCPAL
    U = colrfont.U
    UPM = H * U
    names = ['.notdef', 'space']
    glyphs = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}
    metrics = {'.notdef': (STAGE_W * U, 0), 'space': (8 * U, 0)}
    cmap = {0x20: 'space'}
    layers = {}
    counters = {STAGE_W: 0, SOLO_W: 0, SCENE_W: 0}
    bases = {STAGE_W: STAGE_BASE, SOLO_W: SOLO_BASE, SCENE_W: SCENE_BASE}
    for (w, cells), (w2, k, i) in zip(glyph_frames, order):
        base_cp = bases[w]
        cp = base_cp + counters[w]
        counters[w] += 1
        base = f'g{cp:04X}'
        names.append(base)
        cmap[cp] = base
        metrics[base] = (w * U, 0)
        lay = []
        allc = set()
        for ci, cs in sorted(cells.items()):
            ln = f'{base}_{ci}'
            glyphs[ln] = colrfont.rects_glyph(cs, H)
            names.append(ln)
            metrics[ln] = (w * U, 0)
            lay.append((ln, ci))
            allc |= cs
        glyphs[base] = colrfont.rects_glyph(allc, H) if allc else TTGlyphPen(None).glyph()
        layers[base] = lay
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    # lsb must equal each glyph's xMin: Windows' rasterizer lines a glyph's xMin up with its lsb, so lsb 0 would
    # pull every colour layer left by its own xMin and the layers would no longer line up (holes, stray dots).
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
    fb.font['CPAL'] = buildCPAL([[tuple(c / 255 for c in col[:3]) + (col[3] / 255,) for col in palette]])
    fb.save(path)


def manifest(spr_dir):
    poses, anchors = load('frieren', spr_dir)
    anims = animations('frieren', poses, anchors)
    out = {'height': H, 'stageWidth': STAGE_W, 'soloWidth': SOLO_W, 'families': FAMILY, 'anims': {}}
    s = o = 0
    for k, (ms, fl) in anims.items():
        out['anims'][k] = {'ms': ms, 'stage': [STAGE_BASE + s + i for i in range(len(fl))],
                           'solo': [SOLO_BASE + o + i for i in range(len(fl))]}
        s += len(fl)
        o += len(fl)
    out['scene'] = {'width': SCENE_W, 'slots': SLOTS, 'hit': HIT_X, 'cast': [[SCENE_BASE + k * 12 + i for i in range(12)] for k in range(len(SLOTS))]}
    return out


if __name__ == '__main__':
    spr_dir, fonts_dir, faces_dir, man_path = sys.argv[1:5]
    prev = sys.argv[5] if len(sys.argv) > 5 else None
    only = sys.argv[6].split(',') if len(sys.argv) > 6 else NAMES
    for d in (fonts_dir, faces_dir) + ((prev,) if prev else ()):
        os.makedirs(d, exist_ok=True)
    with open(man_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest(spr_dir), fh, indent=1)
    with Pool(min(16, len(only))) as p:
        for r in p.imap_unordered(build_one, [(n, spr_dir, fonts_dir, faces_dir, prev) for n in only]):
            print(*r, flush=True)







