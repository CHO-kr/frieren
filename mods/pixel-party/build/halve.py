"""Halve pixel art (2x2 cells -> 1 pixel) and keep its dark outline: a cell with an outline pixel becomes outline,
others take their most common color. Opaque when at least 2 of the 4 are (or 1 that is outline)."""
import numpy as np


def lum(c):
    return 0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]


def halve(s, dark=58):
    h, w = s.shape[:2]
    H, W = (h + 1) // 2, (w + 1) // 2
    p = np.zeros((H * 2, W * 2, 4), np.uint8)
    p[:h, :w] = s
    out = np.zeros((H, W, 4), np.uint8)
    L = lum(p[..., :3].astype(float))
    for j in range(H):
        for i in range(W):
            blk = p[j * 2:j * 2 + 2, i * 2:i * 2 + 2].reshape(-1, 4)
            lb = L[j * 2:j * 2 + 2, i * 2:i * 2 + 2].ravel()
            op = blk[:, 3] > 0
            n = op.sum()
            if n == 0:
                continue
            outl = op & (lb < dark)
            if outl.any():
                k = np.nonzero(outl)[0]
                out[j, i] = blk[k[lb[k].argmin()]]
                continue
            if n < 2:
                continue
            cols = [tuple(int(v) for v in c) for c in blk[op]]
            out[j, i] = max(set(cols), key=lambda c: (cols.count(c), -sum(c[:3])))
    ys, xs = np.nonzero(out[..., 3])
    return out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
