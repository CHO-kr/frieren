"""Cut a 4x2 chibi pose sheet (magenta background) into 8 grid-snapped pixel sprites.

usage: python sprites.py <sheet.png> <out_dir> <name>
writes <out_dir>/<name>.npz (poses as RGBA uint8 arrays + anchors) and <name>_preview.png
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage

POSES = ['idle', 'walk', 'attack', 'read', 'write', 'sleep', 'cheer', 'alert']


def bg_mask(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    # magenta and its anti-aliased blends: red and blue both well above green, red close to blue
    mag = (r - g > 70) & (b - g > 70) & (np.abs(r - b) < 90)
    return mag


def gaps(profile, min_len):
    """runs of zeros in profile -> list of (start, end, length)"""
    out, start = [], None
    for i, v in enumerate(profile):
        if v == 0 and start is None:
            start = i
        elif v != 0 and start is not None:
            if i - start >= min_len:
                out.append((start, i, i - start))
            start = None
    if start is not None and len(profile) - start >= min_len:
        out.append((start, len(profile), len(profile) - start))
    return out


def detect_k(a, fg):
    """pixel block size of the art (GPT renders art pixels as k x k blocks)."""
    q = (a // 24).astype(int)
    key = q[..., 0] * 10000 + q[..., 1] * 100 + q[..., 2]
    edges_x = np.argwhere((key[:, 1:] != key[:, :-1]) & fg[:, 1:] & fg[:, :-1])[:, 1] + 1
    edges_y = np.argwhere((key[1:, :] != key[:-1, :]) & fg[1:, :] & fg[:-1, :])[:, 0] + 1
    best = None
    for k in np.arange(6.0, 18.01, 0.05):
        sc = 0
        for e in (edges_x, edges_y):
            if len(e) == 0:
                continue
            fr = []
            for ph in np.arange(0, k, 0.5):
                d = np.abs(((e - ph + k / 2) % k) - k / 2)
                fr.append((d <= 1.0).mean())
            sc += max(fr) - 3.0 / k
        if best is None or sc > best[0]:
            best = (sc, k)
    return best[1]


def phase(a, fg, k, axis):
    q = (a // 24).astype(int)
    key = q[..., 0] * 10000 + q[..., 1] * 100 + q[..., 2]
    if axis == 1:
        e = np.argwhere((key[:, 1:] != key[:, :-1]) & fg[:, 1:] & fg[:, :-1])[:, 1] + 1
    else:
        e = np.argwhere((key[1:, :] != key[:-1, :]) & fg[1:, :] & fg[:-1, :])[:, 0] + 1
    if len(e) == 0:
        return 0.0
    best = None
    for ph in np.arange(0, k, 0.25):
        d = np.abs(((e - ph + k / 2) % k) - k / 2)
        s = (d <= 1.0).mean()
        if best is None or s > best[0]:
            best = (s, ph)
    return best[1]


def resample(a, fg, k, phx, phy, box):
    x0, y0, x1, y1 = box
    # grid lines at phx + n*k covering the box
    nx0 = int(np.floor((x0 - phx) / k)) - 1
    ny0 = int(np.floor((y0 - phy) / k)) - 1
    nx1 = int(np.ceil((x1 - phx) / k)) + 1
    ny1 = int(np.ceil((y1 - phy) / k)) + 1
    W, H = nx1 - nx0, ny1 - ny0
    out = np.zeros((H, W, 4), np.uint8)
    for j in range(H):
        for i in range(W):
            cx0 = phx + (nx0 + i) * k
            cy0 = phy + (ny0 + j) * k
            sx0, sx1 = int(round(cx0 + k * 0.3)), int(round(cx0 + k * 0.7))
            sy0, sy1 = int(round(cy0 + k * 0.3)), int(round(cy0 + k * 0.7))
            sx0, sy0 = max(sx0, 0), max(sy0, 0)
            sx1, sy1 = min(max(sx1, sx0 + 1), a.shape[1]), min(max(sy1, sy0 + 1), a.shape[0])
            if sx0 >= a.shape[1] or sy0 >= a.shape[0]:
                continue
            m = fg[sy0:sy1, sx0:sx1]
            if m.mean() < 0.5:
                continue
            px = a[sy0:sy1, sx0:sx1][m]
            out[j, i, :3] = np.median(px, axis=0)
            out[j, i, 3] = 255
    # trim
    ys, xs = np.nonzero(out[..., 3])
    return out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def quantize(poses, colors):
    fg = np.concatenate([p[p[..., 3] > 0][:, :3] for p in poses])
    strip = Image.fromarray(fg.reshape(1, -1, 3).astype(np.uint8))
    q = strip.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = np.array(q.getpalette()[:colors * 3]).reshape(-1, 3)
    out = []
    for p in poses:
        o = p.copy()
        m = o[..., 3] > 0
        px = o[m][:, :3].astype(int)
        d = ((px[:, None, :] - pal[None, :, :]) ** 2).sum(-1)
        o[m, :3] = pal[d.argmin(1)]
        out.append(o)
    return out


def main(sheet, out_dir, name, colors=28):
    a = np.asarray(Image.open(sheet).convert('RGB'))
    fg = ~bg_mask(a)
    fg = ndimage.binary_opening(fg, iterations=1)
    # rows: largest horizontal gap in the middle third
    rows_prof = fg.sum(1)
    h = len(rows_prof)
    g = [x for x in gaps(rows_prof, 8) if h * 0.25 < (x[0] + x[1]) / 2 < h * 0.75]
    split_y = (max(g, key=lambda x: x[2])[0] + max(g, key=lambda x: x[2])[1]) // 2 if g else h // 2
    k = detect_k(a, fg)
    cells = []
    for ry0, ry1 in ((0, split_y), (split_y, h)):
        sub = fg[ry0:ry1]
        prof = sub.sum(0)
        gp = gaps(prof, 6)
        inner = [x for x in gp if x[0] > 0 and x[1] < len(prof)]
        inner = sorted(sorted(inner, key=lambda x: -x[2])[:3], key=lambda x: x[0])
        cuts = [0] + [(x[0] + x[1]) // 2 for x in inner] + [len(prof)]
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            m = sub[:, c0:c1]
            ys, xs = np.nonzero(m)
            cells.append((c0 + xs.min(), ry0 + ys.min(), c0 + xs.max() + 1, ry0 + ys.max() + 1))
    if len(cells) != 8:
        raise SystemExit(f'{name}: expected 8 poses, found {len(cells)}')
    poses = []
    for box in cells:
        x0, y0, x1, y1 = box
        sa, sf = a[y0:y1, x0:x1], fg[y0:y1, x0:x1]
        phx = phase(sa, sf, k, 1) + x0
        phy = phase(sa, sf, k, 0) + y0
        cut = np.zeros_like(fg)
        cut[y0:y1, x0:x1] = fg[y0:y1, x0:x1]
        poses.append(resample(a, cut, k, phx, phy, box))
    poses = quantize(poses, colors)
    # anchors: x = centroid of the top 35% (the head), baseline = bottom row
    anchors = []
    for p in poses:
        hh = p.shape[0]
        top = p[: max(1, int(hh * 0.35)), :, 3] > 0
        xs = np.nonzero(top)[1]
        anchors.append(float(xs.mean()) if len(xs) else p.shape[1] / 2)
    np.savez_compressed(f'{out_dir}/{name}.npz', k=k, anchors=np.array(anchors),
                        **{POSES[i]: poses[i] for i in range(8)})
    # preview x4
    W = sum(p.shape[1] for p in poses) + 9 * 4
    H = max(p.shape[0] for p in poses) + 8
    pv = Image.new('RGBA', (W, H), (24, 30, 60, 255))
    x = 4
    for p in poses:
        im = Image.fromarray(p, 'RGBA')
        pv.alpha_composite(im, (x, H - 4 - p.shape[0]))
        x += p.shape[1] + 4
    pv.resize((W * 4, H * 4), Image.NEAREST).save(f'{out_dir}/{name}_preview.png')
    print(name, 'k=%.2f' % k, 'sizes', [p.shape[1::-1] for p in poses])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
