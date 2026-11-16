Frieren pixel party: how the sprite fonts are made
- sheets/   Codex-generated pose sheets (sheet_<name>.png, 4x2 poses on magenta) and place tiles (place_<id>.png)
            (not in the GitHub repo, 34 MB; gen_all.ps1 makes new ones. The cut sprites in spr/ are enough to rebuild the fonts)
- sprites.py / cut_all.py / cut_norm.py   cut each sheet into 8 grid-snapped sprites -> spr/<name>.npz
- anim.py   composes the animations + magic effects and builds mods/pixel-party/fonts/FrierenDot<v>-<name>.ttf (COLRv0)
            python anim.py <spr dir> <fonts out> <faces out> <manifest.json> [preview dir]
            v4 adds eat (a meal by the campfire), the left-facing rest_l / eat_l / stand_l / alert_l, and for the
            session header's scene one 256-wide cast per party slot (U+E800 + slot * 12) that flies all the way to the monster
- palettes.py   the 7 background scenes' palettes: the layout's colors per scene -> mods/pixel-chrome/scenes.js
- backdrop.py   draws backdrop-stage.png / backdrop-solo.png and backdrops/<scene>-*.png (the party cards' little stage)
- assets.py     place tiles, background, pixel icons

The session header's scene (pixel-pane):
- gen_scene.ps1     two more Codex sheets: 8 monsters and 8 camp props (4x2 on magenta, not in the repo).
                    -Dir must be a folder the image tool may write to; copy the two PNGs into sheets/ afterwards.
- scene_sprites.py  cuts them -> spr_scene/monsters.npz, props.npz (in the repo: enough to rebuild)
- halve.py          halves them to the characters' pixel size, keeping the dark outline
- scene_art.py      python scene_art.py <herdr home>: scenes/<scene>.png (a 256 x 32 strip of each background: every other
                    pixel of its 512 x 288 art), FrierenDot<v>-monsters.ttf / -props.ttf,
                    and mods/pixel-pane/scene.js (code points, sizes, where everything stands)
- scene_preview.py  composes the scene like pixel-pane (pixel-pane/plan.js has the same rules), for checking and the README

After a rebuild: raise FONT_VERSION in anim.py AND in lib.js (all three copies: pixel-party, pixel-tabs, pixel-pane),
run scene_art.py, delete the old FrierenDot<old>-*.ttf, then make one look change (switch layouts, or wait for the
next scene) so Herdr loads the new families.
Fonts: every glyph's hmtx lsb must equal its xMin, or Windows shifts each colour layer separately.
