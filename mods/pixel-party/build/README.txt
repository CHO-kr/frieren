Frieren pixel party: how the sprite fonts are made
- sheets/   Codex-generated pose sheets (sheet_<name>.png, 4x2 poses on magenta) and place tiles (place_<id>.png)
            (not in the GitHub repo, 34 MB; gen_all.ps1 makes new ones. The cut sprites in spr/ are enough to rebuild the fonts)
- sprites.py / cut_all.py / cut_norm.py   cut each sheet into 8 grid-snapped sprites -> spr/<name>.npz
- anim.py   composes the animations + magic effects and builds mods/pixel-party/fonts/FrierenDot<v>-<name>.ttf (COLRv0)
            python anim.py <spr dir> <fonts out> <faces out> <manifest.json> [preview dir]
- backdrop.py   draws backdrop-stage.png / backdrop-solo.png (the little battle stage behind each sprite)
- assets.py     place tiles, background, pixel icons
After a rebuild: raise FONT_VERSION in anim.py AND in lib.js (all three copies: pixel-party, pixel-tabs, pixel-pane),
delete the old FrierenDot<old>-*.ttf, then switch layouts once so Herdr loads the new family.
Fonts: every glyph's hmtx lsb must equal its xMin, or Windows shifts each colour layer separately.
