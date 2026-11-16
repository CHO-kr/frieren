"""Draws the battle stage exactly as pixel-pane would, from stage_dump.mjs's output and the glyph atlases that anim.py
(<preview dir>/atlas_<name>.npz) and stage_art.py (<atlas dir>/atlas_monsters|fx|props.npz) write.

usage: python stage_preview.py <herdr home> <plans.json> <atlas dir> <out dir> [gif]
  out: stage_<i>.png (a contact sheet of steps) and, with gif, stage_<i>.gif (every step at its own pace)
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

home, plans_path, atlas_dir, out = sys.argv[1:5]
gif = len(sys.argv) > 5
os.makedirs(out, exist_ok=True)
plans = json.load(open(plans_path, encoding='utf-8-sig'))
Z = 2
_atl = {}


def atlas(family):
    name = family.split(' ', 1)[1].lower()
    if name not in _atl:
        _atl[name] = np.load(f'{atlas_dir}/atlas_{name}.npz')
    return _atl[name]


FONT = ImageFont.truetype(f'{home}/mods/pixel-chrome/fonts/Galmuri11.ttf', 12)
FONT9 = ImageFont.truetype(f'{home}/mods/pixel-chrome/fonts/Galmuri9.ttf', 10)


def strip(scene, W):
    js = open(f'{home}/mods/pixel-pane/stage.js', encoding='utf-8').read()
    spec = json.loads(js[js.index('{'):js.rindex('}') + 1])
    im = Image.open(f'{home}/mods/pixel-party/scenes/{scene}.png').convert('RGBA')
    off = round((spec['stripWidth'] - W) * spec['anchor'].get(scene, 0.5))
    return im.crop((off * Z, 0, (off + W) * Z, spec['height'] * Z)), spec


def frame_at(p, t_ms, bg):
    im = bg.copy()
    layer = Image.new('RGBA', (p['W'], bg.height // Z), (0, 0, 0, 0))
    for it in p['items']:
        fr = it['frames'][(t_ms // it['ms']) % len(it['frames'])]
        at = atlas(it['family'])
        x = it['x']
        box = Image.new('RGBA', (it['w'], 32), (0, 0, 0, 0))
        bx = 0
        for cp in fr:
            if cp == 0x20:
                bx += 8
                continue
            g = at.get(f'{cp:x}') if hasattr(at, 'get') else (at[f'{cp:x}'] if f'{cp:x}' in at.files else None)
            if g is None:
                continue
            gi = Image.fromarray(g, 'RGBA')
            if bx < box.width:
                box.alpha_composite(gi if bx + gi.width <= box.width else gi.crop((0, 0, box.width - bx, 32)), (bx, 0))
            # digits advance 4 (their outline spills over); everything else by its own width
            bx += 4 if len(fr) > 1 and it['family'].endswith(' Fx') else gi.width
        layer.alpha_composite(box, (0, 0), (0, 0)) if False else None
        # place (clipped to the stage)
        sx, sy = max(0, x), max(0, it['y'])
        cx, cy = sx - x, sy - it['y']
        if cx < box.width and cy < 32:
            part = box.crop((cx, cy, min(box.width, p['W'] - x), min(32, layer.height - it['y'])))
            if part.width > 0 and part.height > 0:
                layer.alpha_composite(part, (sx, sy))
    im.alpha_composite(layer.resize((layer.width * Z, layer.height * Z), Image.NEAREST))
    return im


def with_log(p, im, step):
    W = im.width
    panel = Image.new('RGBA', (W, im.height + 34), (20, 26, 60, 255))
    panel.paste(im, (0, 0))
    d = ImageDraw.Draw(panel)
    d.fontmode = '1'
    now, before = p['log']
    i = min(step, len(now) - 1)
    title = p.get('title') or []
    if title:
        tt = title[min(step, len(title) - 1)]
        d.text((W - 8 - d.textlength(tt, font=FONT9), im.height + 19), tt, font=FONT9, fill=(127, 216, 200))
    d.text((8, im.height + 3), now[i], font=FONT, fill=(242, 236, 216))
    d.text((8, im.height + 19), before[i], font=FONT9, fill=(163, 163, 208))
    return panel


for n, p in enumerate(plans):
    bg, spec = strip(p['scene'], p['W'])
    step = p['step']
    L = p['L'] if p['mode'] == 'battle' else 24
    ms_per = step if p['mode'] == 'battle' else 100
    shots = [with_log(p, frame_at(p, s * ms_per, bg), s if p['mode'] == 'battle' else 0) for s in range(L)]
    print(f"{n}: {p['scene']} {p['mode']} {p.get('monster')} L={p['L']} boxes={p['boxes']}")
    cols = 4
    sel = shots[::max(1, len(shots) // 24)][:24]
    sheet = Image.new('RGBA', (cols * sel[0].width, ((len(sel) + cols - 1) // cols) * sel[0].height), (0, 0, 0, 255))
    for i, s in enumerate(sel):
        sheet.paste(s, ((i % cols) * s.width, (i // cols) * s.height))
    sheet.convert('RGB').save(f'{out}/stage_{n}.png')
    if gif:
        fr = [s.convert('RGB').quantize(255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for s in shots]
        fr[0].save(f'{out}/stage_{n}.gif', save_all=True, append_images=fr[1:], duration=ms_per, loop=0)
