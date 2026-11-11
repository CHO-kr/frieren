// Journey chrome: the top of the sidebar (brand row) and the bottom (Settings, Add machine).
// The brand row has a "Journey · Day N" widget, counted from the first day on this layout (this mod copy's localStorage).
// Based on traveler-chrome (a copy of Herdr's workspace-chrome 0.1.11).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const DAY = 86400000;
const dayOf = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export default class JourneyChrome extends View {
  init(_props, cx) {
    let start = null;
    try { start = Number(localStorage.getItem("journey.start")) || null; } catch {}
    if (!start) {
      start = dayOf(Date.now());
      try { localStorage.setItem("journey.start", String(start)); } catch {}
    }
    this.start = start;
    // The number follows the date: the 10-minute data timer is enough.
    cx.timer.every(600000, (cx) => cx.notify());
  }

  button(id, label, action, tip) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center()
        .text_color(dim ? t.dim : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/journey-chrome/${icon}.svg`).size(14))
        .when(!collapsed, (el) => el.child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), (el) => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    const day = Math.floor((dayOf(Date.now()) - this.start) / DAY) + 1;
    return h_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).pl(collapsed ? 6 : 12).pr(8).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !collapsed, (el) => el.pl(76))
      .when(!collapsed, (el) => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().size(24).flex_none().border(1).border_color(t.accent).child(image("mods/journey-party/faces/frieren.png").size(22)))
        .child(div().font_semibold().text_color(t.foreground).child("Herdr"))
        .child(div().id("journey-days").text_size(11).text_color(t.accent).tooltip(`Journey started: ${ymd(this.start)}`).child(`Journey · Day ${day}`))))
      .when(!collapsed, (el) => el.child(this.button("search", svg("mods/journey-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }), "Search")))
      .when(!(collapsed && window()?.platform === "macos"), (el) => el.child(this.button("sidebar-toggle", svg("mods/journey-chrome/sidebar.svg").size(15), toggleSidebar, "Fold or unfold the sidebar (Ctrl+Shift+B)")));
  }
}
