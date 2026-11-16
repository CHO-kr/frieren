// Pixel chrome: the top of the sidebar (brand row: Frieren's face, "HERDR", the journey's day and a day/night icon)
// and the bottom (Settings, Add machine) as an RPG command menu. Also carries the layout's fonts:
// fonts/Galmuri*.ttf (Galmuri by quiple, SIL OFL 1.1, see fonts/LICENSE-Galmuri-OFL.txt) and its pixel icons (icons/).
// Based on journey-chrome. The journey day counts from the earlier of this copy's first day and journey-chrome's
// (its localStorage file, data/journey-chrome/store.json), so both layouts show the same day.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, appHome, readTextFile, writeTextFile, checking, nextCommand } from "herdr";

const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const FOLDED = 64; // the sidebar column has 8 px padding on each side: 48 px of room for the rail

// The unfolded width is kept under this layout's own key: journey-chrome's "sidebar.width" is the journey layout's.
// The session lists have no folded form, so they hide while the sidebar is a rail.
const RAIL_HIDES = ["claude-sessions", "codex-sessions"];
function toggleSidebar() {
  const folding = !narrow();
  const width = find(layout(), "sidebar")?.size?.px;
  if (folding) setShared("pixel.sidebar.width", width);
  setShared("sidebar.collapsed", folding);
  for (const id of RAIL_HIDES) if (find(layout(), id)) run(folding ? "layout.hide" : "layout.show", { id });
  run("layout.resize", { id: "sidebar", px: folding ? (window()?.platform === "macos" ? 92 : FOLDED) : (shared("pixel.sidebar.width") ?? 292) });
}

// Scenes: the layout's background takes turns through these, one per hour (backgrounds/frieren-pixel-<id>.png),
// and the whole palette follows: the root's theme color overrides ("colors"), the blocks' frames and gradients, and
// the stage behind each sprite (shared "pixel.scene", read by pixel-party and pixel-pane).
// The brand row's journey widget shows the scene's name and, clicked, moves on to the next (shared "pixel.scene.offset").
// Herdr has no command for a layout's background or colors, so the brand row rewrites the shown layout's file, and only
// when that file's background is one of the scenes (a picture of your own stops the rotation).
import { SCENES } from "./scenes.js";
const SCENE_EVERY = 3600000;
const SCENE_RE = /"image":\s*"backgrounds\/frieren-pixel-[a-z-]+\.png"/;
const sceneIndex = () => {
  const n = Math.floor(Date.now() / SCENE_EVERY) + (Number(shared("pixel.scene.offset")) || 0);
  return ((n % SCENES.length) + SCENES.length) % SCENES.length;
};
const scenePath = (sc) => `backgrounds/frieren-pixel-${sc.id}.png`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneLine = (o) => `{ ${Object.entries(o).map(([k, v]) => `"${k}": "${v}"`).join(", ")} }`;

// The layout file with scene `sc` painted in: block colors swapped role by role from whichever scene's colors the
// file has now (hand-picked colors are left alone), the root "colors" line replaced or added after "theme", and
// the background picture.
function paint(text, sc) {
  const count = (s) => Object.values(s.layout).filter((c) => text.toLowerCase().includes(`"${c.toLowerCase()}"`)).length;
  const from = SCENES.reduce((best, s) => (count(s) > count(best) ? s : best), SCENES[0]);
  let out = text;
  if (count(from) > 0 && from !== sc) {
    const map = new Map(Object.entries(from.layout).map(([role, c]) => [c.toLowerCase(), sc.layout[role]]));
    const re = new RegExp(`"(${[...map.keys()].sort((a, b) => b.length - a.length).map(esc).join("|")})"`, "gi");
    out = out.replace(re, (m, c) => `"${map.get(c.toLowerCase()) ?? c}"`);
  }
  const colors = `"colors": ${oneLine(sc.colors)}`;
  if (/"colors":\s*\{[^{}]*\}/.test(out)) out = out.replace(/"colors":\s*\{[^{}]*\}/, colors);
  else out = out.replace(/^([ \t]*)"theme":\s*"[^"]*",[ \t]*$/m, (line, indent) => `${line}\n${indent}${colors},`);
  return out.replace(SCENE_RE, `"image": "${scenePath(sc)}"`);
}

const DAY = 86400000;
const dayOf = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export default class PixelChrome extends View {
  init(_props, cx) {
    let start = null;
    try { start = Number(localStorage.getItem("journey.start")) || null; } catch {}
    if (!start) {
      start = dayOf(Date.now());
      try { localStorage.setItem("journey.start", String(start)); } catch {}
    }
    this.start = start;
    cx.timer.every(600000, (cx) => cx.notify());
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/data/journey-chrome/store.json`);
        const theirs = Number(JSON.parse(text ?? "{}")["journey.start"]) || null;
        if (theirs && theirs < this.start) {
          this.start = theirs;
          try { localStorage.setItem("journey.start", String(theirs)); } catch {}
          cx.notify();
        }
      } catch {}
    });
    // Only the brand row turns the scenes (the footer is another copy of this mod).
    if (_props?.footer || props()?.footer) return;
    this.applied = null;
    this.applying = false;
    cx.spawn(async (cx) => this.applyScene(cx));
    cx.timer.every(60000, (cx) => cx.spawn(async (cx) => this.applyScene(cx)));
    // Key command "pixel-chrome.next-scene" (bind it in keys.json) does what clicking the journey day does.
    cx.spawn(async (cx) => {
      for (;;) if (String(await nextCommand()).endsWith("next-scene")) this.nextScene(cx);
    });
  }

  // Puts the current scene into the shown layout's file, if that layout's background is one of the scenes.
  async applyScene(cx) {
    const sc = SCENES[sceneIndex()];
    if (this.applying || this.applied === sc.id) return;
    const name = shared("layout");
    if (!name) return;
    this.applying = true;
    try {
      const file = `${appHome()}/layouts/${name}.json`;
      const text = await readTextFile(file);
      if (text && SCENE_RE.test(text)) {
        const next = paint(text, sc);
        if (next !== text) await writeTextFile(file, next, text);
        this.applied = sc.id;
        if (shared("pixel.scene") !== sc.id) setShared("pixel.scene", sc.id);
        cx.notify();
      }
    } catch {}
    this.applying = false;
  }

  nextScene(cx) {
    setShared("pixel.scene.offset", (Number(shared("pixel.scene.offset")) || 0) + 1);
    cx.spawn(async (cx) => this.applyScene(cx));
  }

  button(id, icon, action, tip) {
    const t = theme();
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(svg(ICON(icon)).size(16));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, action) => h_flex().id(id).h(26).px(6).gap(8).items_center()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.accent)).cursor_pointer()
        .on_click(action)
        .child(svg(ICON(icon)).size(14))
        .when(!collapsed, (el) => el.child(label));
      return v_flex().size_full().px(6).py(4).gap(2).text_size(12).justify_center()
        .child(row("settings", "settings", "Settings", () => run("app.settings"))
          .when(Boolean(updates().app.ready), (el) => el.child(div().size(6).bg(t.accent))))
        .child(row("machine", "plus", "Add machine", () => run("mod.open", { name: "machine-add" })));
    }
    const day = Math.floor((dayOf(Date.now()) - this.start) / DAY) + 1;
    const hour = new Date().getHours();
    const night = hour < 6 || hour >= 18;
    return h_flex().size_full().pl(collapsed ? 4 : 8).pr(4).gap(4).items_center().text_size(12)
      .when(window()?.platform === "macos" && !collapsed, (el) => el.pl(76))
      .when(!collapsed, (el) => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().size(36).flex_none().border(2).border_color(t.accent).child(image("mods/pixel-party/faces/frieren.png").size(32)))
        .child(v_flex().gap(2)
          .child(div().font_family("Galmuri14").text_size(15).text_color(t.foreground).child("HERDR"))
          .child(h_flex().id("journey-days").gap(4).items_center().cursor_pointer().hover((s) => s.opacity(0.8))
            .tooltip(`Journey began ${ymd(this.start)}\nScene: ${SCENES[sceneIndex()].name} (changes every hour)\nClick: next scene`)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.nextScene(cx))
            .child(svg(ICON(night ? "moon" : "sun")).size(10).text_color(night ? "#c8d4ff" : t.accent))
            .child(div().font_family("Galmuri9").text_size(10).text_color(t.accent).child(`Journey · Day ${day}`))))))
      .when(!collapsed, (el) => el.child(this.button("search", "search", () => run("mod.open", { name: "picker" }), "Search")))
      .when(!(collapsed && window()?.platform === "macos"), (el) => el.child(this.button("sidebar-toggle", "sidebar", toggleSidebar, collapsed ? "Unfold sidebar" : "Fold sidebar (Ctrl+Shift+B hides it)")));
  }
}
