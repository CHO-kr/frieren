import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from multiprocessing import Pool
import sprites
NAMES = ['frieren','fern','stark','himmel','heiter','eisen','sein','ubel','land','denken','methode','flamme','serie','kanne','lawine','wirbel']
BASE = os.path.dirname(os.path.abspath(__file__))
def one(n):
    sprites.detect_k = lambda a, fg: 12.0
    try:
        sprites.main(f'{BASE}/gen/sheet_{n}.png', f'{BASE}/spr', n)
        return n, 'ok'
    except BaseException as e:
        return n, f'ERR {e}'
if __name__ == '__main__':
    with Pool(16) as p:
        for n, r in p.imap_unordered(one, NAMES): print(n, r, flush=True)
