"""Static pixel assets for the frieren-pixel layout: place tiles, background, pixel icons.

usage: python assets.py <gen_dir> <herdr_home>
"""
import sys, os
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def cellmode(im, W, H, colors=32, inner=0.2):
    im = im.convert('RGB')
    q = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = np.array(q.getpalette()[:colors * 3]).reshape(-1, 3)
    a = np.asarray(q)
    h, w = a.shape
    out = np.zeros((H, W, 3), np.uint8)
    for y in range(H):
        for x in range(W):
            y0, y1 = int(y * h / H), int((y + 1) * h / H)
            x0, x1 = int(x * w / W), int((x + 1) * w / W)
            my, mx = int((y1 - y0) * inner), int((x1 - x0) * inner)
            c = a[y0 + my:max(y1 - my, y0 + my + 1), x0 + mx:max(x1 - mx, x0 + mx + 1)].ravel()
            out[y, x] = pal[np.bincount(c).argmax()]
    return Image.fromarray(out)


ICONS = {
    # 8x8 pixel icons, '#' = ink (svg() tints them with the text colour)
    'search': ['..###...', '.#...#..', '#.....#.', '#.....#.', '#.....#.', '.#...#..', '..###.#.', '.......#'],
    'settings': ['...##...', '.#.##.#.', '..####..', '###..###', '###..###', '..####..', '.#.##.#.', '...##...'],
    'plus': ['...##...', '...##...', '...##...', '########', '########', '...##...', '...##...', '...##...'],
    'sidebar': ['########', '#..#...#', '#..#...#', '#..#...#', '#..#...#', '#..#...#', '#..#...#', '########'],
    'grimoire': ['.######.', '#.#....#', '#.#.##.#', '#.#....#', '#.#.##.#', '#.#....#', '#.######', '.#######'],
    'quill': ['......##', '.....###', '....###.', '...###..', '..###...', '.###....', '.#......', '#.......'],
    'win-min': ['........', '........', '........', '........', '........', '........', '########', '########'],
    'win-max': ['########', '########', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
    'win-restore': ['..######', '..#....#', '########', '######.#', '#....#.#', '#....###', '#....#..', '######..'],
    'win-close': ['##....##', '###..###', '.######.', '..####..', '..####..', '.######.', '###..###', '##....##'],
    'close': ['#......#', '.#....#.', '..#..#..', '...##...', '...##...', '..#..#..', '.#....#.', '#......#'],
    'split-right': ['########', '#...#..#', '#...#..#', '#...#..#', '#...#..#', '#...#..#', '#...#..#', '########'],
    'split-down': ['########', '#......#', '#......#', '#......#', '########', '#......#', '#......#', '########'],
    'zoom': ['###..###', '##....##', '#.#..#.#', '........', '........', '#.#..#.#', '##....##', '###..###'],
    'unzoom': ['.#....#.', '###..###', '.##..##.', '........', '........', '.##..##.', '###..###', '.#....#.'],
    'monitor': ['########', '#......#', '#......#', '#......#', '########', '...##...', '..####..', '........'],
    'server': ['########', '#.#....#', '########', '........', '########', '#.#....#', '########', '........'],
    'chevron-right': ['........', '..#.....', '..##....', '..###...', '..###...', '..##....', '..#.....', '........'],
    'chevron-down': ['........', '........', '########', '.######.', '..####..', '...##...', '........', '........'],
    'branch': ['.#......', '.#...#..', '.#...#..', '.#..#...', '.#.#....', '.##.....', '.#......', '.#......'],
    'sun': ['...#....', '.#.#.#..', '..###...', '#######.', '..###...', '.#.#.#..', '...#....', '........'],
    'moon': ['..###...', '.##.....', '##......', '##......', '##......', '.##.....', '..###...', '........'],
    'cursor': ['#.......', '##......', '###.....', '####....', '###.....', '##......', '#.......', '........'],
    'heart': ['.##.##..', '#######.', '#######.', '.#####..', '..###...', '...#....', '........', '........'],
}


def svg(rows):
    n = len(rows)
    rects = []
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            if row[x] == '#':
                s = x
                while x < len(row) and row[x] == '#':
                    x += 1
                rects.append(f'<rect x="{s}" y="{y}" width="{x - s}" height="1"/>')
            else:
                x += 1
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {len(rows[0])} {n}" width="{len(rows[0]) * 2}" '
            f'height="{n * 2}" shape-rendering="crispEdges" fill="#ffffff">' + ''.join(rects) + '</svg>\n')


def main(gen, home):
    mods = f'{home}/mods'
    # place tiles: 32x32 art, shown at 64x64
    art = f'{mods}/pixel-spaces/art'
    os.makedirs(art, exist_ok=True)
    for n in ['capital', 'ruins', 'meadow', 'camp', 'tower', 'street', 'tree', 'moon']:
        im = Image.open(f'{gen}/place_{n}.png')
        cellmode(im, 32, 32).resize((64, 64), Image.NEAREST).save(f'{art}/{n}.png')
    # background: 512x288 art shown at x5 (2560x1440)
    bg = Image.open(f'{gen}/../test_bg.png').convert('RGB')
    w, h = bg.size
    ch = int(w * 9 / 16)
    top = max(0, (h - ch) // 2 + 30)
    bg = bg.crop((0, top, w, top + ch))
    os.makedirs(f'{home}/backgrounds', exist_ok=True)
    cellmode(bg, 512, 288, colors=64, inner=0.25).resize((2560, 1440), Image.NEAREST).save(f'{home}/backgrounds/frieren-pixel-night.png', optimize=True)
    # icons
    ic = f'{mods}/pixel-chrome/icons'
    os.makedirs(ic, exist_ok=True)
    for k, rows in ICONS.items():
        with open(f'{ic}/{k}.svg', 'w') as fh:
            fh.write(svg(rows))
    print('assets ok')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
