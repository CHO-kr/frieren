import sys, numpy as np
from PIL import Image
def period(img):
    a = np.asarray(img.convert('RGB')).astype(np.int32)
    res = []
    for axis in (1, 0):
        d = np.abs(np.diff(a, axis=axis)).sum(axis=2)
        prof = d.sum(axis=0 if axis == 1 else 1).astype(float)
        prof -= prof.mean()
        best = None
        for p in np.arange(8, 60, 0.05):
            # comb score: sum of profile sampled at k*p + phase
            n = len(prof)
            scores = []
            for ph in np.arange(0, p, 1.0):
                idx = np.round(np.arange(ph, n - 1, p)).astype(int)
                scores.append((prof[idx].mean(), ph))
            sc, ph = max(scores)
            if best is None or sc > best[0]: best = (sc, p, ph)
        res.append(best)
    return res
for f in sys.argv[1:]:
    im = Image.open(f)
    print(f, im.size, [(round(p,2), ph, round(sc,1)) for sc,p,ph in period(im)])
