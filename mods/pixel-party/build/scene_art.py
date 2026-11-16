"""The session-header scene's art (besides the characters' own fonts, anim.py):
- scenes/<scene>.png   a 256 x 32 strip of each background's own pixel art (every other pixel of the backgrounds'
                       512 x 288 art, drawn at 5x, so one strip pixel is 10 screen pixels), shown at 2x: the ground the party stands on
- fonts/FrierenDot<v>-monsters.ttf   one monster per background scene and a golem for bigger parties: 'idle' and
                       'battle' (flinches on frames 9-10, when a cast's burst lands: every view shares one clock)
- fonts/FrierenDot<v>-props.ttf      campfire (lit, embers, cooking pot), tent, chests, bedroll, signpost, backpack, ring
- <pixel-pane>/scene.js  the code points, widths and frame times of all of it, and where things stand

usage: python scene_art.py <herdr home>
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageEnhance

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anim  # noqa: E402
from anim import Canvas, H, hexc, sparkle  # noqa: E402
from halve import halve  # noqa: E402

V = anim.FONT_VERSION
HERE = os.path.dirname(os.path.abspath(__file__))

# background scene -> (first row of the 32-row strip, mirrored, brightness, the monster met there)
SCENES = {
    'night': (108, False, 1.0, 'wyvern'),
    'dawn-flowers': (108, False, 1.0, 'slime'),
    'meteor-night': (112, False, 1.25, 'wisp'),
    'snow-north': (108, False, 1.0, 'wolf'),
    'autumn-road': (108, False, 1.0, 'stump'),
    'mage-library': (104, False, 1.2, 'mimic'),
    'lakeside-town': (112, True, 1.0, 'serpent'),
}
MONSTERS = {  # name, rows above the ground it hovers, bob
    'wyvern': ('Wyvern', 3, True), 'slime': ('Blue Slime', 0, False), 'wisp': ("Will-o'-Wisp", 5, True),
    'wolf': ('Frost Wolf', 0, False), 'stump': ('Grumpy Stump', 0, False), 'mimic': ('Mimic', 0, False),
    'serpent': ('Lake Serpent', 0, False), 'golem': ('Stone Golem', 0, False),
}
MW = 40  # monster glyph width: the sprite at x=2 (room to be knocked back)

# where things stand in the 256-wide strip (art px). Party heads: anim.SLOTS (battle), CAMP (camp, R = facing left)
CAMP = [(96, False), (146, True), (70, False), (172, True)]
FIRE_X = 121  # campfire centre
PLACES = {'tent': 202, 'bedroll': 206, 'backpack': 30, 'signpost': 6}


def band(home, scene):
    start, mirror, bright, _ = SCENES[scene]
    a = np.asarray(Image.open(f'{home}/backgrounds/frieren-pixel-{scene}.png').convert('RGB'))
    nat = Image.fromarray(a[5::10, 5::10][:144, :256][start:start + 32])
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
    h, w = spr.shape[:2]
    base_y = H - h - hover
    # hovering ones bob up and down; ones on the ground lean a step toward the party and back
    wave = [0, 0, -1, -1, -1, 0, 0, 1, 1, 1, 0, 0] if bob else [0] * 12
    lean = [0] * 12 if bob else [0] * 6 + [-1] * 6
    idle, battle = [], []
    for f in range(12):
        for hurt, out in ((False, idle), (True, battle)):
            cv = Canvas(MW)
            ground_shadow(cv, 2 + w // 6, w * 2 // 3, 60 if hover else 90)
            dx, tint, k = lean[f], None, 0.0
            dy = wave[f]
            if hurt and f == 9:
                dx, tint, k = 2, (255, 255, 255), 0.7
            elif hurt and f == 10:
                dx, tint, k = 1, (255, 70, 70), 0.35
            put(cv, spr, 2 + dx, base_y + dy, tint, k)
            out.append(cv.out())
    return idle, battle


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
    # sparks
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
    """name -> (ms, [frames]) and each glyph's width"""
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
        # the pot's top: the first row of its middle that isn't empty below the tripod's apex
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


def main(home):
    party = f'{home}/mods/pixel-party'
    os.makedirs(f'{party}/scenes', exist_ok=True)
    for sc in SCENES:
        band(home, sc).resize((512, 64), Image.NEAREST).save(f'{party}/scenes/{sc}.png')

    M = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/monsters.npz').items()}
    P = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/props.npz').items()}

    glyphs, mon = [], {}
    for i, (n, (title, hover, bob)) in enumerate(MONSTERS.items()):
        idle, battle = monster_frames(M[n], hover, bob)
        base = 0xE000 + i * 0x20
        glyphs += [(base + k, MW, f) for k, f in enumerate(idle)] + [(base + 12 + k, MW, f) for k, f in enumerate(battle)]
        mon[n] = {'name': title, 'idle': [base + k for k in range(12)], 'battle': [base + 12 + k for k in range(12)],
                  'w': M[n].shape[1]}
    build_font(f'{party}/fonts/FrierenDot{V}-monsters.ttf', f'FrierenDot{V} Monsters', glyphs)

    glyphs, props, cp = [], {}, 0xE000
    for n, (ms, frames, w) in props_glyphs(P).items():
        props[n] = {'ms': ms, 'w': w, 'cps': list(range(cp, cp + len(frames)))}
        glyphs += [(cp + k, w, f) for k, f in enumerate(frames)]
        cp += len(frames)
    build_font(f'{party}/fonts/FrierenDot{V}-props.ttf', f'FrierenDot{V} Props', glyphs)

    spec = {
        'version': V, 'width': anim.SCENE_W, 'height': H, 'sx': anim.SX, 'stageWidth': anim.STAGE_W,
        'slots': anim.SLOTS, 'hit': anim.HIT_X, 'monsterLeft': anim.HIT_X - 2, 'camp': CAMP, 'fireX': FIRE_X,
        'places': PLACES, 'scenes': {sc: v[3] for sc, v in SCENES.items()}, 'boss': 'golem',
        'monsters': mon, 'props': props,
        'cast': [[anim.SCENE_BASE + k * 12 + i for i in range(12)] for k in range(len(anim.SLOTS))],
    }
    js = ('// Generated by mods/pixel-party/build/scene_art.py: the session-header scene (pixel-pane): the strip of each\n'
          '// background (mods/pixel-party/scenes/<scene>.png), the monster and prop glyphs (FrierenDot<v> Monsters / Props)\n'
          '// and where the party, the monster and the camp stand, in art pixels (shown at 2x).\n'
          f'export const SCENE = {json.dumps(spec, indent=1)};\n')
    with open(f'{home}/mods/pixel-pane/scene.js', 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(js)
    print('bands', len(SCENES), '| monsters', len(mon), '| props', {n: len(p['cps']) for n, p in props.items()})


if __name__ == '__main__':
    main(sys.argv[1])
