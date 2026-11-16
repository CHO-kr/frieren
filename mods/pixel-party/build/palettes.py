"""Scene palettes for Frieren Pixel: one UI palette and one stage-backdrop palette per background scene.

The night palette is the layout's original look. The others keep its lightness structure (so text reads the
same everywhere) and move its hues: the dark "base" family (panels, terminals, borders) to the scene's
shadow hue, the light "frame" family (frames, text) to the scene's light, plus a scene accent and a
"working" color.

usage: python palettes.py <scenes.js> [swatch.png]
  scenes.js  mods/pixel-chrome/scenes.js: SCENES = [{id, name, layout: {...}, colors: {...}}] in rotation order
"""
import sys, json, colorsys

# ---- the night look (theme frieren-pixel + layout file) ----
NIGHT_BASE_HUE = 232
BASE = {  # role: night color (the dark family; hue moves to the scene's base hue)
    'headTop': '#22307c', 'headBottom': '#0e1546', 'bodyTop': '#1c2a74', 'bodyBottom': '#0c123f',
    'chrome': '#121a4c', 'surface': '#1a2462', 'popover': '#151d50', 'raised': '#28327e', 'input': '#3c4696',
    'border': '#7880c8', 'selection': '#3a3f8a', 'term': '#0b1030', 'dim': '#a3a3d0', 'idle': '#8890bc',
    'accentFg': '#141a3c', 'ansi8': '#6e74a8',
}
NIGHT_FRAME = '#efe6c8'
LIGHT = {'foreground': '#f2ecd8', 'muted': '#d2c9a8', 'hover': '#fff4d0'}  # follow the frame's hue
ALPHA = {'headTop': 'f2', 'headBottom': 'f2', 'bodyTop': 'f0', 'bodyBottom': 'f0', 'chrome': 'f0', 'surface': 'e6',
         'popover': 'fa', 'term': 'c4', 'hover': '1c', 'selected': '2e', 'paneBorder': 'a8'}

# ---- scenes, in rotation order: name, base hue, base saturation multiplier, frame, accent, working ----
SCENES = {
    'night':         dict(name='Starry Night Road', hue=232, sat=1.00, frame='#efe6c8', accent='#ffd36a', working='#86b4ff'),
    'dawn-flowers':  dict(name='Spring Dawn Meadow', hue=248, sat=0.62, frame='#f7e4ea', accent='#ffb4cf', working='#93b4ff'),
    'meteor-night':  dict(name='Meteor Shower', hue=244, sat=1.00, frame='#e3ddff', accent='#a6e6ff', working='#b39cff'),
    'snow-north':    dict(name='Northern Aurora', hue=214, sat=0.95, frame='#e6f1ff', accent='#8ff0c6', working='#9cc6ff'),
    'autumn-road':   dict(name='Autumn Forest Road', hue=14, sat=0.62, frame='#f6e2c2', accent='#ffbb52', working='#7fd8c8'),
    'mage-library':  dict(name='Mage Library', hue=258, sat=0.55, frame='#efdcbc', accent='#ffc062', working='#9cbcff'),
    'lakeside-town': dict(name='Lakeside Town at Sunset', hue=292, sat=0.62, frame='#fde3d4', accent='#ffa060', working='#8fbaff'),
}

# ---- stage backdrops (backdrop.py): sky1..3, glow, ridge, hill, grass, grass2, tuft, stars, flowers, extra ----
STAGES = {
    'night': dict(sky=['#3e4699', '#525ab4', '#6e6cc6'], glow='#a98cc8', ridge='#4a5aa8', hill='#34448a',
                  ground=['#2f6b52', '#3a7e5e'], tuft='#5aa673', star='#c8d0ff', flowers=['#ffffff', '#a8c8ff', '#ffd0e8']),
    'dawn-flowers': dict(sky=['#8ea6ea', '#aeb0ee', '#dcb6dc'], glow='#f8d0bc', ridge='#c6c2e6', hill='#9c9ccc',
                         ground=['#6c9468', '#7ea676'], tuft='#9cc086', star='#dfe6ff', flowers=['#ffffff', '#7ea0f2', '#ffc8dc']),
    'meteor-night': dict(sky=['#2e3486', '#40449e', '#5a56b8'], glow='#9884d6', ridge='#3c4894', hill='#2a3276',
                         ground=['#2a5c5a', '#336a64'], tuft='#4c8a74', star='#e8ecff', flowers=['#ffffff', '#b8c8ff', '#d8c0ff'],
                         extra='meteors'),
    'snow-north': dict(sky=['#2e4c8e', '#3e62a8', '#5680c2'], glow='#a8c8f0', ridge='#c6d6f2', hill='#94acd8',
                       ground=['#d6e2f8', '#c0d0f0'], tuft='#a6bae4', star='#e6f0ff', flowers=['#ffffff', '#e8f0ff', '#b8f0d8'],
                       extra='aurora', aurora=['#7fe2b4', '#5cc4a8']),
    'autumn-road': dict(sky=['#e0905a', '#eaa862', '#f2c272'], glow='#ffe0a0', ridge='#b06e5a', hill='#8e5444',
                        ground=['#9c5436', '#ac623a'], tuft='#d08438', star=None, flowers=['#d8463a', '#ffc040', '#f08040']),
    'mage-library': dict(sky=['#5e4670', '#70547c', '#8a6680'], glow='#e0a862', ridge='#4c3658', hill='#3e2c4a',
                         ground=['#744630', '#835234'], tuft='#9c663e', star='#ffd27a', flowers=['#ffe6a8', '#a8c8ff', '#ffd27a']),
    'lakeside-town': dict(sky=['#6a3c98', '#a84890', '#e06a70'], glow='#ffb070', ridge='#5a3a7c', hill='#472e68',
                          ground=['#8e6a7c', '#9c7882'], tuft='#be8c84', star='#ffd8e4', flowers=['#ffffff', '#ffb070', '#ff9ac0']),
}


def hx(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))


def hexc(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(v * 255))) for v in rgb)


def shift(c, hue, sat_mul=1.0, ref_hue=NIGHT_BASE_HUE, sat_set=None):
    h, l, s = colorsys.rgb_to_hls(*hx(c))
    nh = ((hue + (h * 360 - ref_hue)) % 360) / 360
    ns = sat_set if sat_set is not None else min(1.0, s * sat_mul)
    return hexc(colorsys.hls_to_rgb(nh, l, ns))


def palette(sc):
    p = SCENES[sc]
    if sc == 'night':
        base = dict(BASE)
        light = dict(LIGHT)
    else:
        base = {k: shift(v, p['hue'], p['sat']) for k, v in BASE.items()}
        fh, fl, fs = colorsys.rgb_to_hls(*hx(p['frame']))
        nh, nl, ns = colorsys.rgb_to_hls(*hx(NIGHT_FRAME))
        light = {}
        for k, v in LIGHT.items():
            h, l, s = colorsys.rgb_to_hls(*hx(v))
            light[k] = hexc(colorsys.hls_to_rgb(fh, l, min(1.0, s * (fs / ns if ns else 1))))
    frame, accent, working = p['frame'], p['accent'], p['working']
    layout = {
        'frame': frame, 'paneBorder': frame + ALPHA['paneBorder'], 'focus': accent,
        'headTop': base['headTop'] + ALPHA['headTop'], 'headBottom': base['headBottom'] + ALPHA['headBottom'],
        'bodyTop': base['bodyTop'] + ALPHA['bodyTop'], 'bodyBottom': base['bodyBottom'] + ALPHA['bodyBottom'],
    }
    colors = {
        'background': base['term'] + ALPHA['term'], 'foreground': light['foreground'], 'muted': light['muted'],
        'dim': base['dim'], 'accent': accent, 'accent_foreground': base['accentFg'], 'selection': base['selection'],
        'selected': accent + ALPHA['selected'], 'working': working, 'idle': base['idle'],
        'chrome': base['chrome'] + ALPHA['chrome'], 'surface': base['surface'] + ALPHA['surface'],
        'popover': base['popover'] + ALPHA['popover'], 'raised': base['raised'], 'hover': light['hover'] + ALPHA['hover'],
        'border': base['border'], 'input': base['input'], 'ring': accent,
        'ansi0': base['term'], 'ansi8': base['ansi8'],
    }
    return {'layout': layout, 'colors': colors}


def swatches(pals, path):
    from PIL import Image, ImageDraw
    keys = ['frame', 'focus', 'headTop', 'bodyTop', 'bodyBottom'] + ['background', 'foreground', 'muted', 'dim', 'accent',
                                                                       'working', 'border', 'raised', 'selection']
    W = 40
    im = Image.new('RGB', (len(keys) * W + 140, len(pals) * 44 + 10), (0, 0, 0))
    d = ImageDraw.Draw(im)
    for r, (sc, p) in enumerate(pals.items()):
        d.text((4, 10 + r * 44 + 12), sc, fill=(255, 255, 255))
        for i, k in enumerate(keys):
            c = p['layout'].get(k) or p['colors'].get(k)
            d.rectangle((140 + i * W, 10 + r * 44, 140 + i * W + W - 4, 10 + r * 44 + 36), fill=hexc(hx(c[:7])))
    im.save(path)


def scenes_js(pals):
    one = lambda d: '{ ' + ', '.join(f'"{k}": "{v}"' for k, v in d.items()) + ' }'
    rows = []
    for sc, p in pals.items():
        rows.append(f'  {{\n    id: "{sc}", name: "{SCENES[sc]["name"]}",\n    layout: {one(p["layout"])},\n'
                    f'    colors: {one(p["colors"])},\n  }},')
    return ('// Generated by mods/pixel-party/build/palettes.py: the background scenes in rotation order, each with the\n'
            '// layout\'s block colors (layout) and the theme colors it overrides in the layout root (colors).\n'
            'export const SCENES = [\n' + '\n'.join(rows) + '\n];\n')


if __name__ == '__main__':
    pals = {sc: palette(sc) for sc in SCENES}
    with open(sys.argv[1], 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(scenes_js(pals))
    if len(sys.argv) > 2:
        swatches(pals, sys.argv[2])
    print('scenes:', ', '.join(pals))
