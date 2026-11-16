// Pixel tab bar: each tab is an inventory slot with its party member's pixel face (same picks as pixel-party) and status;
// on the right, the + menu, the Files / Changes panel buttons and the Windows window buttons. Based on journey-tabs.
// A tab nobody named shows "6 · <name>" in a dimmer color: its resumed agent session's title, else its first pane's repo
// or folder, else its program (names.js; the tab itself keeps its number). A colored bar on the left marks its project
// (the repo root or folder of its first pane), the same color for the same project.
// The + menu is pixel-new-menu (accounts listed, the one with the most usage left first).
// Reads: the session caches (claude-list.json, codex-list.json) once a minute; `git rev-parse --show-toplevel` once per
// first-pane folder (again after 10 minutes).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, panes, terminals, run, openOverlay, theme, window, shared, setShared, layout, settings, appHome, home, readTextFile, exec, checking } from "herdr";
import { character, facePath, entriesFor, settle, alpha, mix } from "./lib.js";
import { isUnnamed, tabFacts, projectColor, unnamedTip } from "./names.js";

const JOBS_FILE = `${appHome()}/mods/journey-party/jobs.json`;
const DATA = () => `${home()}/AppData/Local/herdr-sessions`;
const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const ROOT_AGAIN = 10 * 60000;
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class PixelTabs extends View {
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
    this.claude = [];
    this.codex = [];
    this.roots = {}; // JSON [machine, cwd] -> { root: repo root | null (no repo), at }
    this.asking = new Set();
    this.loadSessions(cx);
    cx.timer.every(60000, (cx) => this.loadSessions(cx));
  }

  // The session panels' caches: the titles of resumed sessions.
  loadSessions(cx) {
    cx.spawn(async (cx) => {
      const [c, x] = await Promise.all([
        readTextFile(`${DATA()}/claude-list.json`).catch(() => null),
        readTextFile(`${DATA()}/codex-list.json`).catch(() => null),
      ]);
      if (c === this.claudeText && x === this.codexText) return;
      this.claudeText = c;
      this.codexText = x;
      const claude = parse(c)?.sessions, codex = parse(x)?.threads;
      if (Array.isArray(claude)) this.claude = claude;
      if (Array.isArray(codex)) this.codex = codex;
      cx.notify();
    });
  }

  // A folder's repo root: known (a path), none (null), or not yet (undefined, asked now).
  rootOf(machine, cwd, cx) {
    const key = JSON.stringify([machine ?? null, cwd]);
    const known = this.roots[key];
    if ((!known || Date.now() - known.at > ROOT_AGAIN) && !this.asking.has(key) && !checking()) {
      this.asking.add(key);
      cx.spawn(async (cx) => {
        let root = known?.root ?? null;
        try {
          const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: machine ?? null, timeout: 10000 });
          root = r.code === 0 ? r.stdout.trim() || null : null;
        } catch {} // couldn't ask (a machine away, a folder gone): keep what it had
        this.asking.delete(key);
        this.roots[key] = { root, at: Date.now() };
        if (!known || known.root !== root) cx.notify();
      });
    }
    return known?.root;
  }

  // The side panel is remembered per space (as journey-tabs does).
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
    try { localStorage.setItem("panels", JSON.stringify(this.panels)); } catch {}
  }

  render(cx) {
    const t = theme();
    const sp = spaces();
    const list = agents();
    const space = sp.find((p) => p.active);
    const shown = space?.tabs ?? [];
    const ps = panes();
    const argvs = new Map(terminals().map((k) => [k.address, k.argv]));
    const machine = space?.machine ?? null;
    const factsOf = (c) => tabFacts(ps.filter((p) => p.tab === c.id), {
      argvOf: (a) => argvs.get(a), rootOf: (cwd) => this.rootOf(machine, cwd, cx),
      claude: this.claude, codex: this.codex, home: machine ? null : home(), machine,
    });
    const stored = shared("journey.party") ?? {};
    const picks = settle(stored, entriesFor(sp, list), this.jobs);
    if (this.jobsLoaded && JSON.stringify(picks) !== JSON.stringify(stored)) setShared("journey.party", picks);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, icon, action, tip) => div().id(id).size(30).flex_none().flex().items_center().justify_center().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.accent)).when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", stop).on_click(action).child(svg(ICON(icon)).size(16));
    const item = (c, i) => {
      const program = ps.find((p) => p.tab === c.id && p.program?.agent)?.program ?? ps.find((p) => p.tab === c.id)?.program;
      const facts = factsOf(c);
      // Nobody named it: its number, then a name it's shown under (never given to the tab).
      const derived = isUnnamed(c) ? facts.name : null;
      const name = derived ? `${c.index} · ${derived.text}` : /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const ch = character(picks[`tab:${c.id}`]);
      const mark = facts.project ? projectColor(facts.project.key, t) : null;
      const text = c.active ? t.foreground : t.muted;
      const tip = [
        ch ? `${name} · ${ch.name} (${ch.role})` : name,
        derived ? unnamedTip(derived.source) : null,
        facts.project?.name ? `Project: ${facts.project.name}` : null,
      ].filter(Boolean).join("\n");
      const label = derived
        ? h_flex().max_w(170).min_w(0).gap(5).items_center()
          .child(div().flex_none().child(String(c.index)))
          .child(div().min_w(0).truncate().text_color(mix(text, t.background, 0.3)).child(`· ${derived.text}${c.zoomed ? " Z" : ""}`))
        : div().max_w(180).truncate().child(c.zoomed ? `${name} Z` : name);
      return h_flex().id(`tab-${c.id}`).h(44).pl(2).pr(9).gap(7).items_center().flex_none()
        .border(2).border_color(c.active ? t.accent : alpha(t.border, "70")).bg(c.active ? alpha(t.accent, "1c") : alpha(t.background, "6b")).text_color(text)
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        // the project's color bar, close beside the face
        .when(Boolean(mark) || Boolean(ch), (el) => el.child(h_flex().flex_none().gap(3).items_center()
          .when(Boolean(mark), (g) => g.child(div().w(4).h(30).flex_none().bg(mark).border_t(1).border_color("#ffffff59")))
          .when(Boolean(ch), (g) => g.child(div().size(36).flex_none().child(image(facePath(ch)).size(36).when(!c.active, (img) => img.opacity(0.8)))))))
        .when(!ch && Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .when(c.active, (el) => el.child(svg(ICON("cursor")).size(10).flex_none().text_color(t.accent)))
        .child(label)
        .when(c.status === "working", (el) => el.child(div().flex_none().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 160)))
        .when(c.status === "blocked", (el) => el.child(div().flex_none().text_color(t.blocked).frames(["!", " "], 400)))
        .when(c.status === "done", (el) => el.child(div().flex_none().text_color(t.done).child("★")))
        .when(c.active, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover((s) => s.text_color(t.blocked)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg(ICON("close")).size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 8;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      // In a narrow bar these give way after the tabs (the label goes, the icon stays); the window buttons never do.
      return h_flex().id(`panel-${id}`).h(30).px(9).gap(6).flex_shrink(1).min_w(38).overflow_hidden().items_center().tooltip(label)
        .border(2).border_color(on ? t.accent : alpha(t.border, "70")).bg(on ? t.selected : alpha(t.background, "6b")).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(16).flex_none().text_color(t.accent)).child(div().min_w(0).truncate().child(label));
    };
    return h_flex().size_full().min_w(0).pr(6).pl(lightsPadding).gap(5).items_center().text_size(12)
      .on_mouse_up("left", () => { this.pressed = null; })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(5).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "plus", () => openOverlay({ mod: "pixel-new-menu", kind: "popup", width: 250, height: 560 }), "New tab"))
      .when(enabled.includes("files"), (el) => el.child(panelButton("files", "Files", ICON("grimoire"))))
      .when(enabled.includes("changes"), (el) => el.child(panelButton("changes", "Changes", ICON("quill"))))
      .when(w?.buttons, (el) => el.child(div().w(6))
        .child(button("minimize", "win-min", () => run("window.minimize")))
        .child(button("maximize", w.maximized ? "win-restore" : "win-max", () => run("window.maximize")))
        .child(button("close-window", "win-close", () => run("window.close"))));
  }
}
