"""Compose the session-header scene the way pixel-pane draws it (same rules as scene.js + pixel-pane/main.js), to check
the art without Herdr and to make the README's pictures.

usage: python scene_preview.py <herdr home> <out dir> [gif]
"""
import sys, os, json, re
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anim  # noqa: E402
import scene_art as sa  # noqa: E402
from halve import halve  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_cache = {}


def char_anims(name):
    if name not in _cache:
        poses, anchors = anim.load(name, f'{HERE}/spr')
        an = anim.animations(name, poses, anchors)
        stage = {k: (ms, [f(anim.STAGE_W) for f in fl]) for k, (ms, fl) in an.items()}
        casts = anim.scene_casts(name, poses, anchors)
        _cache[name] = (stage, casts)
    return _cache[name]


_art = {}


def art():
    if not _art:
        M = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/monsters.npz').items()}
        P = {n: halve(s, 40) for n, s in np.load(f'{HERE}/spr_scene/props.npz').items()}
        _art['mon'] = {n: sa.monster_frames(M[n], *sa.MONSTERS[n][1:]) for n in M}
        _art['props'] = sa.props_glyphs(P)
    return _art['mon'], _art['props']


def plan(members, scene, night):
    """members: [(character, status, anim, own)] -> list of (x_art, frames(ms, list)) in drawing order"""
    mon, props = art()
    stat = [m[1] for m in members]
    mode = 'battle' if 'working' in stat else 'victory' if 'done' in stat else 'camp'
    out = []
    P = lambda n: (props[n][0], props[n][1])
    if mode == 'camp':
        out += [(sa.PLACES['signpost'], P('signpost')), (sa.PLACES['backpack'], P('backpack')), (sa.PLACES['tent'], P('tent'))]
        if night:
            out.append((sa.PLACES['bedroll'], P('bedroll')))
        fire = 'embers' if night else 'cook' if 'idle' in stat else 'fire'
        out.append((sa.FIRE_X - props[fire][2] // 2, P(fire)))
    else:
        mname = sa.SCENES[scene][3] if len(members) < 3 else 'golem'
        if mode == 'battle':
            casting = any(m[2] == 'cast' for m in members)
            idle, battle = mon[mname]
            out.append((anim.HIT_X - 2, (90, battle if casting else idle)))
        else:
            out.append((anim.HIT_X - 4, P('treasure')))
    if len(members) > 1:
        own = [i for i, m in enumerate(members) if m[3]][0]
        head = sa.CAMP[own][0] if mode == 'camp' else anim.SLOTS[own]
        out.append((head - 11, P('ring')))
    for i, (ch, st, an, own) in enumerate(members):
        stage, casts = char_anims(ch)
        if mode == 'camp':
            head, flip = sa.CAMP[i]
            a = 'alert' if st == 'blocked' else 'stand' if st not in ('idle',) else ('rest' if night else 'eat')
            if flip:
                a += '_l'
            out.append((head - (anim.STAGE_W - 1 - anim.SX) if flip else head - anim.SX, stage[a]))
        else:
            head = anim.SLOTS[i]
            a = an if st == 'working' else 'alert' if st == 'blocked' else 'victory' if st == 'done' else 'stand'
            if a == 'cast':
                out.append((0, (90, casts[i])))
            else:
                out.append((head - anim.SX, stage[a]))
    return mode, out


def frame_at(home, scene, items, t):
    im = Image.open(f'{home}/mods/pixel-party/scenes/{scene}.png').convert('RGBA').resize((256, 32), Image.NEAREST)
    for x, (ms, fl) in items:
        f = fl[int(t // ms) % len(fl)]
        layer = Image.fromarray(f, 'RGBA')
        im.alpha_composite(layer, (max(0, x), 0), (max(0, -x), 0))
    return im


CASES = [
    ('night', [('frieren', 'working', 'cast', True)], False, 'solo battle'),
    ('snow-north', [('fern', 'working', 'cast', True), ('stark', 'working', 'read', False)], False, 'two in battle'),
    ('autumn-road', [('himmel', 'working', 'cast', True), ('heiter', 'working', 'summon', False), ('eisen', 'working', 'cast', False), ('frieren', 'idle', 'rest', False)], False, 'party vs boss'),
    ('lakeside-town', [('frieren', 'idle', 'rest', True), ('fern', 'idle', 'rest', False), ('stark', 'idle', 'rest', False)], False, 'meal at camp'),
    ('mage-library', [('frieren', 'idle', 'rest', True), ('fern', 'idle', 'rest', False)], True, 'asleep at camp'),
    ('dawn-flowers', [('serie', 'done', 'victory', True), ('land', 'idle', 'rest', False)], False, 'victory'),
    ('meteor-night', [('ubel', 'working', 'cast', True)], False, 'solo battle'),
    ('night', [('frieren', 'idle', 'rest', True)], False, 'solo meal'),
]

if __name__ == '__main__':
    home, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    gif = len(sys.argv) > 3
    rows = []
    for scene, members, night, title in CASES:
        mode, items = plan(members, scene, night)
        rows.append(frame_at(home, scene, items, 900))  # mid-flight for casts
        if gif:
            frames = [frame_at(home, scene, items, t).resize((512, 64), Image.NEAREST) for t in range(0, 2160, 45)]
            frames[0].save(f'{out}/{title.replace(" ", "_")}_{scene}.gif', save_all=True, append_images=frames[1:], duration=45, loop=0, disposal=2)
    sheet = Image.new('RGBA', (256 * 2 + 2, len(rows) // 2 * 34), (0, 0, 0, 255))
    for i, r in enumerate(rows):
        sheet.alpha_composite(r, ((i % 2) * 258, (i // 2) * 34))
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(f'{out}/scenes_sheet.png')
    print('ok', len(rows))
