import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from multiprocessing import Pool
import numpy as np
import sprites
NAMES = ['frieren','fern','stark','himmel','heiter','eisen','sein','ubel','land','denken','methode','flamme','serie','kanne','lawine','wirbel']
BASE = os.path.dirname(os.path.abspath(__file__))
def one(n):
    h = int(np.load(f'{BASE}/spr/{n}.npz')['idle'].shape[0])
    target = min(max(h, 26), 30)
    k = 12.0 * h / target
    sprites.detect_k = lambda a, fg, k=k: k
    sprites.main(f'{BASE}/gen/sheet_{n}.png', f'{BASE}/spr', n)
    return n, h, k
if __name__ == '__main__':
    with Pool(16) as p:
        for r in p.imap_unordered(one, NAMES): print(*r, flush=True)
