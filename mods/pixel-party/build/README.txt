Frieren pixel party: how the sprite fonts are made
- sheets/   Codex-generated pose sheets (sheet_<name>.png, 4x2 poses on magenta) and place tiles (place_<id>.png)
- sprites.py / cut_all.py / cut_norm.py   cut each sheet into 8 grid-snapped sprites -> spr/<name>.npz
- anim.py   composes the animations + magic effects and builds mods/pixel-party/fonts/FrierenDot<v>-<name>.ttf (COLRv0)
            python anim.py <spr dir> <fonts out> <faces out> <manifest.json> [preview dir]
            v4 added eat (a meal by the campfire) and the left-facing rest_l / eat_l / stand_l / alert_l;
            v5 adds the battle stage's glyphs (BATTLE, from U+EC00): attack, hurt, guard, run, swing, jump poses with the
            head at x 16, and this character's own beam / bolt head / slash wave / holy orb / burst / x-slash.
            With a preview dir it also saves atlas_<name>.npz (every glyph as an image) for stage_preview.py.
- palettes.py   the 7 background scenes' palettes: the layout's colors per scene -> mods/pixel-chrome/scenes.js
- backdrop.py   draws backdrop-stage.png / backdrop-solo.png and backdrops/<scene>-*.png (the party cards' little stage)
- assets.py     place tiles, background, pixel icons

The battle stage (pixel-pane with props { stage: true }):
- gen_scene.ps1     two more Codex sheets: 8 monsters and 8 camp props (4x2 on magenta, not in the repo).
                    -Dir must be a folder the image tool may write to; copy the two PNGs into sheets/ afterwards.
- scene_sprites.py  cuts them -> spr_scene/monsters.npz, props.npz (in the repo: enough to rebuild)
- halve.py          halves them to the characters' pixel size, keeping the dark outline
- stage_art.py      python stage_art.py <herdr home> [atlas dir]: scenes/<scene>.png (a 512 x 36 strip of each
                    background's 512 x 288 art, saved at 2x), FrierenDot<v>-monsters.ttf (idle, hurt, attack, spawn),
                    -fx.ttf (numbers, words, HP bar, the monsters' shots, and every work kind's effect: anvil, blade,
                    banner, aura, potion, meteor, blast, footprints, lens, bubbles, map, arrow, hourglass, grimoire,
                    shooting star, flowers, butterfly, fishing rod, training dummy), -props.ttf (camp),
                    and mods/pixel-pane/stage.js (code points, widths, monster shapes, the characters' attack tips)
- special_art.py    imported by stage_art.py: FrierenDot<v>-special.ttf, the specials (SPECIAL: each character's move,
                    its name and how it plays: beam, barrage, rain, inferno, tornado, ice, tide, chains, thunder,
                    mirror, cuts, skysplit, quake, flash, judgment, sanctuary), each character's magic circle and big
                    impact in its own colors, the banners (WAVE 1, WAVE 2, BOSS, RAGE!, VICTORY! and every move's
                    name, 5x7 letters on a ribbon, with a glint), the dimmed and flashing stage (64-wide tiles), the
                    SP gauge (5 levels and a full blink) and the shockwave. Its code points go into stage.js ("sp").
                    stage_art.py writes each font to <name>.new and replaces it only when the bytes changed; Herdr
                    keeps a loaded family, so build new art in a copy of the herdr home and raise FONT_VERSION.
- stage_dump.mjs    node stage_dump.mjs <pixel-pane dir> <cases.json> > plans.json: runs pixel-pane/plan.js for
                    test cases ([{ scene, W, night, pick, members: [[id, status, kind, own, summons, kinds]] }];
                    kinds: the kinds of work done lately, which the member's turns go through). Each plan has its
                    timeline's turns ([step, character, kind or "special"]) and the log title per step.
- stage_preview.py  python stage_preview.py <herdr home> <plans.json> <atlas dir> <out dir> gif: draws them exactly as
                    pixel-pane would (atlases from anim.py's preview dir and stage_art.py's atlas dir, in one folder)

After a rebuild: raise FONT_VERSION in anim.py AND in lib.js (all three copies: pixel-party, pixel-tabs, pixel-pane),
run anim.py and stage_art.py, delete the old FrierenDot<old>-*.ttf, then make one look change (switch layouts, or
wait for the next scene) so Herdr loads the new families.
Fonts: every glyph's hmtx lsb must equal its xMin, or Windows shifts each colour layer separately.
