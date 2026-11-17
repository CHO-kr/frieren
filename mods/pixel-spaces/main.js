// Pixel spaces: each space is a destination on the journey, with a pixel place tile; worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo its first terminal is in now, only
// where unusual: branch, ahead/behind. Click to travel there, right-click for its menu, drag to reorder.
// Based on journey-spaces (same places, same pins in journey-spaces/places.json), drawn in pixels.
// With exactly one space it shows that space as one slim row and shrinks its block to fit (layout.resize on the block
// holding it, as pixel-quest's "fit" does; fit.js); with two or more the block gets back the size it had.
// props (optional): fit false: never resize the block; block: that block's id when a layout has two pixel-spaces blocks.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, appHome, readTextFile, props, checking } from "herdr";
import { fitHeight, plan, H } from "./fit.js";

// One place per space. Pin one in journey-spaces/places.json like {"space name": "camp"};
// otherwise the name picks a fixed place (reordering spaces doesn't change it).
const PLACES = { capital: "Royal Capital", ruins: "Old Ruins", meadow: "Flower Hill", camp: "Forest Camp", tower: "Rampart Watchtower", street: "Town Street", tree: "Starlit Old Tree", moon: "Moonlit Castle" };
const PLACE_IDS = Object.keys(PLACES);
const PLACES_FILE = `${appHome()}/mods/journey-spaces/places.json`;
const placeOf = (name, places) => (PLACE_IDS.includes(places[name]) ? places[name] : PLACE_IDS[[...name].reduce((n, c) => n + c.codePointAt(0), 0) % PLACE_IDS.length]);
const placeFor = (name, places) => `mods/pixel-spaces/art/${placeOf(name, places)}.png`;
const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
// Theme colors follow the background scene (pixel-chrome writes them into the layout); this adds an alpha.
const alpha = (c, a) => `${String(c ?? "#000000").slice(0, 7)}${a}`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function findWhere(node, test) {
  if (node && test(node)) return node;
  for (const child of node?.children ?? []) {
    const found = findWhere(child, test);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
// Same as pixel-chrome's toggleSidebar, unfolding only: brings the session lists back and the width it had.
function unfoldSidebar() {
  setShared("sidebar.collapsed", false);
  for (const id of ["claude-sessions", "codex-sessions"]) if (find(layout(), id)) run("layout.show", { id });
  run("layout.resize", { id: "sidebar", px: shared("pixel.sidebar.width") ?? 292 });
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
// Every folder a space has a terminal in: its tabs are often different projects.
function keysOf(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  const dirs = new Set(ps.filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd));
  if (!dirs.size && s.folder) dirs.add(s.folder);
  return [...dirs].map((d) => JSON.stringify([s.machine ?? null, d]));
}
const rowHeight = ({ tree }) => (tree ? 28 : 76);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.places = {};
    cx.spawn(async (cx) => {
      const text = await readTextFile(PLACES_FILE).catch(() => null);
      try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.places = parsed; } catch {}
      cx.notify();
    });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // fit.js's memory: the weight to give back, the px last asked for
    try { this.fitMem = JSON.parse(localStorage.getItem("fit") ?? "{}") ?? {}; } catch { this.fitMem = {}; }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const s of sp) for (const k of keysOf(s, ps)) keys.add(k);
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) {
        this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
        if (p.cwd) this.sameRepo(JSON.stringify([spaceOf[p.tab].machine ?? null, p.cwd]), keys).forEach((k) => due.add(k));
      }
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, dirty: 0, upstream: false, top: top.stdout.trim(), repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line && !line.startsWith("# ")) info.dirty++;
        else if (line.startsWith("# branch.upstream ")) info.upstream = true;
        else if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null, sum: this.sum(w, ps) })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer: [{ el, h }] (h: its px, for fit.js).
  // single: the only space, as one slim row.
  grouped(t, collapsed, single) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? { el: this.compact(r, t), h: r.tree ? 0 : 40 }
      : single ? { el: this.slim(r, t), h: H.slim } : { el: this.row(r, t), h: rowHeight(r) });
    const fixed = (el, h) => ({ el, h });
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [fixed(loadingRow(null), 28)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().font_family("Galmuri9").text_size(10).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(ICON(m ? "server" : "monitor")).size(12).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).hover(s => s.bg(t.hover).text_color(t.accent))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(ICON(`chevron-${folded ? "right" : "down"}`)).size(10).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center()
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.accent))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg(ICON("plus")).size(12)).when(!collapsed, el => el.child("New space here"));
      return [fixed(head, 26), ...(folded ? [] : mine.length ? mine.map(draw) : [fixed(loading(m) ? loadingRow(m) : empty, 28)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .font_family("Galmuri9")
      .text_size(10)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // A space's git added up over its folders; a repo seen from two folders counts once.
  sum(w, ps) {
    const repos = new Map();
    for (const k of keysOf(w, ps)) if (this.git[k]) repos.set(JSON.stringify([w.machine ?? null, this.git[k].top]), this.git[k]);
    const all = [...repos.values()];
    return {
      dirty: all.reduce((n, g) => n + g.dirty, 0),
      ahead: all.reduce((n, g) => n + g.ahead, 0),
      local: all.filter((g) => !g.upstream && g.branch !== "(detached)").length,
    };
  }

  gitLines(sum, t) {
    const line = (color, text) => div().truncate().font_family("Galmuri9").text_size(10).text_color(color).child(text);
    return [
      sum.dirty > 0 && line(t.ansi3, `${sum.dirty} uncommitted ${sum.dirty === 1 ? "file" : "files"}`),
      sum.ahead > 0 && line(t.ansi2, `${sum.ahead} unpushed ${sum.ahead === 1 ? "commit" : "commits"}`),
      sum.local > 0 && line(t.ansi1, `${sum.local} ${sum.local === 1 ? "repo" : "repos"} without a remote`),
    ].filter(Boolean);
  }

  row({ w, i, g, sum, tree }, t) {
    const on = w.active;
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .border(2)
      .when(on, (el) => el.bg(alpha(t.accent, "14")).border_color(t.accent))
      .when(!on, (el) => el.border_color("#00000000").hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg(ICON("branch")).size(12).text_color(t.dim)))
          .when(!tree, el => el.child(div().id(`place-${w.id}`).size(68).flex_none().border(2).border_color(on ? t.accent : alpha(t.border, "80"))
            .tooltip(PLACES[placeOf(w.name, this.places)])
            .child(image(placeFor(w.name, this.places)).size(64))))
          .child(v_flex().flex_1().min_w(0).gap(3)
            .child(h_flex().gap(6).items_center()
              .when(on, el => el.child(svg(ICON("cursor")).size(10).flex_none().text_color(t.accent)))
              .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
              .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()))
            .when(!tree, el => el.child(div().font_family("Galmuri9").text_size(10).text_color(t.accent).child(PLACES[placeOf(w.name, this.places)])))
            .when(!tree, el => el.children(this.gitLines(sum, t)))),
      );
  }

  // The only space: one slim row. Its place, git notes and branch line in the tooltip; uncommitted files as ±n.
  slim({ w, g, sum }, t) {
    const on = w.active;
    const place = PLACES[placeOf(w.name, this.places)];
    const notes = [
      sum.dirty > 0 && `${sum.dirty} uncommitted ${sum.dirty === 1 ? "file" : "files"}`,
      sum.ahead > 0 && `${sum.ahead} unpushed ${sum.ahead === 1 ? "commit" : "commits"}`,
      sum.local > 0 && `${sum.local} ${sum.local === 1 ? "repo" : "repos"} without a remote`,
    ].filter(Boolean);
    const small = (el) => el.flex_none().font_family("Galmuri9").text_size(10);
    return h_flex()
      .id(`space-${w.id}`)
      .h(H.slim)
      .flex_none()
      .px(5)
      .gap(7)
      .items_center()
      .border(2)
      .when(on, (el) => el.bg(alpha(t.accent, "14")).border_color(t.accent))
      .when(!on, (el) => el.border_color("#00000000").hover((s) => s.bg(t.hover)))
      .tooltip([`${w.name} · ${place}`, ...notes].join("\n"))
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => this.menu(w))
      .child(div().size(28).flex_none().border(1).border_color(on ? t.accent : alpha(t.border, "80")).child(image(placeFor(w.name, this.places)).size(26)))
      .when(on, (el) => el.child(svg(ICON("cursor")).size(10).flex_none().text_color(t.accent)))
      .child(div().flex_shrink(0).max_w(140).truncate().text_color(t.foreground).child(w.name))
      .child(g ? this.gitTail(g, null, w.name, t) : div().flex_1())
      .when(sum.dirty > 0, (el) => el.child(small(div()).text_color(t.ansi3).child(`±${sum.dirty}`)))
      .when(sum.local > 0, (el) => el.child(small(div()).text_color(t.ansi1).child("no remote")));
  }

  // fit.js: the block's size by how many spaces there are. items: grouped()'s rows with their heights.
  fit(items, count) {
    const p = props() ?? {};
    // nothing listed yet (a new space waits a moment for its git): no size to fit to
    if (checking() || p.fit === false || (count === 1 && !items.length)) return;
    const node = findWhere(layout(), typeof p.block === "string" ? (n) => n.id === p.block : (n) => n.content?.mod === "pixel-spaces");
    const chrome = 2 * (Number(node?.border?.width) || 0);
    const r = plan(node, count, count === 1 ? fitHeight(items.map((i) => i.h), chrome) : null, this.fitMem);
    if (JSON.stringify(r.mem) !== JSON.stringify(this.fitMem)) {
      this.fitMem = r.mem;
      try { localStorage.setItem("fit", JSON.stringify(r.mem)); } catch {}
    }
    if (r.resize) {
      try { run("layout.resize", r.resize); } catch {}
    }
  }

  // Folded sidebar: the space's place tile, framed in gold when it's the shown one.
  compact({ w, tree }, t) {
    if (tree) return div();
    return div()
      .id(`space-${w.id}`)
      .relative()
      .size(40)
      .flex_none()
      .mx_auto()
      .border(2)
      .border_color(w.active ? t.accent : alpha(t.border, "80"))
      .hover((s) => s.border_color(t.accent))
      .tooltip(`${w.name} · ${PLACES[placeOf(w.name, this.places)]}`)
      .on_click(() => run("space.select", { id: w.id }))
      .child(image(placeFor(w.name, this.places)).size(36).when(!w.active, (el) => el.opacity(0.75)))
      .when(w.status === "working" || w.status === "blocked" || w.status === "done", (el) => el.child(div().absolute().right(0).bottom(0).size(8)
        .bg(tone(t, w.status)).border(1).border_color(alpha(t.background, ""))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const railUnfold = collapsed && window()?.platform === "macos";
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const single = sp.length === 1;
    const items = this.grouped(t, collapsed, single);
    this.fit(items, sp.length);
    return v_flex().size_full().min_h(0).text_size(12)
      .child(h_flex().h(28).flex_none().pl(railUnfold ? 2 : 10).pr(railUnfold ? 2 : 6).gap(railUnfold ? 2 : 6).items_center().border_b(2).border_color(alpha(t.border, "60"))
        // Folded on macOS, the brand row is all traffic lights (pixel-chrome hides its button), so unfold from here.
        .when(railUnfold, el => el.child(div().id("sidebar-unfold").size(24).flex_none().flex().items_center().justify_center().text_color(t.dim)
          .hover(s => s.bg(t.hover).text_color(t.accent)).tooltip("Unfold sidebar").on_click(() => unfoldSidebar()).child(svg(ICON("sidebar")).size(14))))
        .when(!collapsed, el => el.child(svg(ICON("chevron-right")).size(12).text_color(t.accent)).child(div().text_color(t.accent).child("SPACES"))
          .child(div().font_family("Galmuri9").text_size(10).text_color(t.muted).child("DESTINATIONS")))
        .child(div().flex_1())
        .child(div().id("space-new").size(24).flex_none().flex().items_center().justify_center().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.accent))
          .tooltip("New space").on_click(() => run("space.new")).child(svg(ICON("plus")).size(12))))
      // One space: no scrolling, the row in the middle of whatever room the block has (its layout min may leave some).
      .child(single
        ? v_flex().flex_1().min_h(0).px(6).pt(H.padTop).pb(H.padBottom).gap(H.gap).justify_center().overflow_hidden()
          .children(items.map((i) => i.el))
        : v_flex().flex_1().min_h(0).px(6).pt(4).pb(10).gap(2).overflow_y_scrollbar().mode("always")
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
          .children(items.map((i) => i.el)));
  }
}
