"""Cut the scene sheets (4x2 grids on magenta, gen_scene.ps1) into grid-snapped pixel sprites, like sprites.py does
for the character sheets.

usage: python scene_sprites.py <sheets dir> <out dir>
writes <out dir>/monsters.npz and props.npz (one RGBA array per name) and a x4 preview of each
"""
import sys, os
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprites import bg_mask, gaps, detect_k, phase, resample, quantize  # noqa: E402

SHEETS = {
    'monsters': ['wyvern', 'slime', 'wisp', 'wolf', 'stump', 'mimic', 'serpent', 'golem'],
    'props': ['logs', 'pot', 'tent', 'chest', 'chest_open', 'bedroll', 'signpost', 'backpack'],
}


def cells_of(fg):
    rows_prof = fg.sum(1)
    h = len(rows_prof)
    g = [x for x in gaps(rows_prof, 8) if h * 0.25 < (x[0] + x[1]) / 2 < h * 0.75]
    split_y = (max(g, key=lambda x: x[2])[0] + max(g, key=lambda x: x[2])[1]) // 2 if g else h // 2
    cells = []
    for ry0, ry1 in ((0, split_y), (split_y, h)):
        sub = fg[ry0:ry1]
        prof = sub.sum(0)
        inner = [x for x in gaps(prof, 6) if x[0] > 0 and x[1] < len(prof)]
        inner = sorted(sorted(inner, key=lambda x: -x[2])[:3], key=lambda x: x[0])
        cuts = [0] + [(x[0] + x[1]) // 2 for x in inner] + [len(prof)]
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            ys, xs = np.nonzero(sub[:, c0:c1])
            cells.append((c0 + xs.min(), ry0 + ys.min(), c0 + xs.max() + 1, ry0 + ys.max() + 1))
    return cells


def cut(sheet, names, colors):
    a = np.asarray(Image.open(sheet).convert('RGB'))
    fg = ndimage.binary_opening(~bg_mask(a), iterations=1)
    cells = cells_of(fg)
    if len(cells) != len(names):
        raise SystemExit(f'{sheet}: expected {len(names)} sprites, found {len(cells)}')
    k = detect_k(a, fg)
    out = []
    for x0, y0, x1, y1 in cells:
        sa, sf = a[y0:y1, x0:x1], fg[y0:y1, x0:x1]
        m = np.zeros_like(fg)
        m[y0:y1, x0:x1] = fg[y0:y1, x0:x1]
        out.append(resample(a, m, k, phase(sa, sf, k, 1) + x0, phase(sa, sf, k, 0) + y0, (x0, y0, x1, y1)))
    return dict(zip(names, quantize(out, colors))), k


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    for sheet, names in SHEETS.items():
        sprs, k = cut(f'{src}/sheet_{sheet}.png', names, 40)
        np.savez_compressed(f'{dst}/{sheet}.npz', **sprs)
        W = sum(s.shape[1] for s in sprs.values()) + 4 * (len(sprs) + 1)
        H = max(s.shape[0] for s in sprs.values()) + 8
        pv = Image.new('RGBA', (W, H), (24, 30, 60, 255))
        x = 4
        for s in sprs.values():
            pv.alpha_composite(Image.fromarray(s, 'RGBA'), (x, H - 4 - s.shape[0]))
            x += s.shape[1] + 4
        pv.resize((W * 4, H * 4), Image.NEAREST).save(f'{dst}/{sheet}_preview.png')
        print(sheet, 'k=%.2f' % k, {n: s.shape[1::-1] for n, s in sprs.items()})
