// Journey tab bar: each tab shows its party member's face (same picks as journey-party) and status; on the right, panel buttons and
// Windows window buttons. Based on traveler-tabs (a copy of Herdr's tabs 0.1.11).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, appHome, readTextFile } from "herdr";
import { character, facePath, entriesFor, settle } from "./lib.js";

const JOBS_FILE = `${appHome()}/mods/journey-party/jobs.json`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class JourneyTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.jobs = {};
    this.jobsLoaded = false;
    cx.spawn(async (cx) => {
      const text = await readTextFile(JOBS_FILE).catch(() => null);
      try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.jobs = parsed; } catch {}
      this.jobsLoaded = true;
      cx.notify();
    });
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const sp = spaces();
    const list = agents();
    const space = sp.find((p) => p.active);
    const shown = space?.tabs ?? [];
    const stored = shared("journey.party") ?? {};
    const picks = settle(stored, entriesFor(sp, list), this.jobs);
    if (this.jobsLoaded && JSON.stringify(picks) !== JSON.stringify(stored)) setShared("journey.party", picks);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find((p) => p.tab === c.id && p.program?.agent)?.program ?? panes().find((p) => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const ch = character(picks[`tab:${c.id}`]);
      return h_flex().id(`tab-${c.id}`).h(46).pl(3).pr(9).gap(8).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.accent : t.border).bg(c.active ? t.raised : t.surface).text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip(ch ? `${name} · ${ch.name} (${ch.role})` : name)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(ch), (el) => el.child(div().size(40).flex_none().border(1).border_color(c.active ? ch.color : `${ch.color}66`)
          .child(image(facePath(ch)).size(38).when(!c.active, (img) => img.opacity(0.85)))))
        .when(!ch && Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(180).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", (el) => el.child(div().size(7).rounded(4).bg(t[c.status])))
        .when(c.active, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(28).px(9).gap(6).flex_none().items_center()
        .text_size(12).border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(15).flex_none().text_color(t.accent)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(4).items_center().bg(t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(4).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", svg("mods/journey-chrome/plus.svg").size(15), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), (el) => el.child(panelButton("files", "Files", "mods/journey-tabs/grimoire.svg")))
      .when(enabled.includes("changes"), (el) => el.child(panelButton("changes", "Changes", "mods/journey-tabs/quill.svg")))
      .when(w?.buttons, (el) => el.child(div().w(6))
        .child(button("minimize", w.platform === "windows" ? svg("mods/journey-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/journey-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/journey-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
