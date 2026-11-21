// Claude and Codex sessions started in Herdr tabs, with every account: claude, claude2, claude3,
// codex and codex2..codex5, and the copies made from them. list.py finds them under the tabs'
// processes every 30 seconds and remembers them, so a session stays listed after its tab is
// closed. Sessions the desktop apps made (and copies of them), and sessions made in another
// terminal, go to the Claude and Codex panels. A click goes to the session's tab, or resumes it in
// a new tab with the account that made it; a right click offers the other accounts and a copy.
// This panel also runs spaces.py every minute and shares its answer with the other panels.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, terminals, agents, panes, spaces, run, theme, notify, appHome, layout, openOverlay, shared, setShared, nextCommand } from "herdr";

// The session-search window (Ctrl+Shift+S) hands its pick here, to open as if clicked in this list.
const REQUEST = "sessions.request.herdr";

// Spaces. spaces.py sorts every session into one of the spaces in spaces.json (none: no
// sorting, every session listed); this panel shares the answer as "sessions.spaces" ({spaces: [{name, folder, about}],
// map: {"claude:<id>" | "codex:<id>": name}}), and a pick in the right-click menu
// ("sessions.space.assign", {key: name}) wins. While one of those spaces is shown, the list keeps
// its sessions and any open in its tabs; unsorted ones fold under "Not sorted". A session opens
// in its space. The same few lines are in the Claude, Codex and menu mods.
const SPACES = "sessions.spaces";
const ASSIGN = "sessions.space.assign";
const NOT_SORTED = "Not sorted";
const sortedSpaces = () => shared(SPACES)?.spaces ?? [];
const spaceOf = (key) => (shared(ASSIGN) ?? {})[key] ?? shared(SPACES)?.map?.[key] ?? null;

// One read of the shared lists for a whole draw.
function spaceLookup() {
  const picks = shared(ASSIGN) ?? {};
  const map = shared(SPACES)?.map ?? {};
  return (key) => picks[key] ?? map[key] ?? null;
}
// Worked out once per session per draw: asking again in every filter of a draw runs past the
// time Herdr gives one with a few hundred sessions ("This view could not be re-rendered").
const once = (f) => {
  const seen = new Map();
  return (s) => {
    if (!seen.has(s)) seen.set(s, f(s));
    return seen.get(s);
  };
};
function shownSpace() {
  const shown = spaces().find((p) => p.active);
  return shown && sortedSpaces().some((s) => s.name === shown.name) ? shown : null;
}
// The space spaces.json names "all" (it sorts nothing), when it is the shown one: the list then has
// every space's sessions in one, each row naming its space, the unsorted ones folded at the bottom.
function everySpace() {
  const name = shared(SPACES)?.all;
  return name ? spaces().find((p) => p.active && p.name === name) ?? null : null;
}
// In the session's space when it has one (made if it was closed), else in the shown one.
function openTab(tab, key) {
  const name = key ? spaceOf(key) : null;
  const sp = name && spaces().find((p) => p.name === name);
  if (sp) return run("tab.new", { ...tab, space: sp.id });
  if (name && sortedSpaces().some((s) => s.name === name)) return run("space.new", { name, folder: tab.folder, tab: tab.name, argv: tab.argv });
  return run("tab.new", tab);
}
function spaceGroup(key) {
  const mine = (shared(ASSIGN) ?? {})[key];
  const auto = shared(SPACES)?.map?.[key] ?? null;
  const now = mine ?? auto;
  const items = sortedSpaces().map((s) => ({
    label: s.name,
    note: s.name === now ? (mine ? "Here now · your pick" : "Here now · sorted by its words") : s.about,
    action: s.name === now ? null : { assign: { key, space: s.name } },
  }));
  if (mine) items.push({ label: "Sort by its words", note: auto ? `That gives ${auto}` : "That leaves it unsorted", action: { assign: { key, space: null } } });
  return { label: "Space", items };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as the agents list reads it.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const DAY = 86400000;
function group(ms, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (ms >= start) return "Today";
  if (ms >= start - DAY) return "Yesterday";
  if (ms >= start - 6 * DAY) return "Last 7 days";
  if (ms >= start - 29 * DAY) return "Last 30 days";
  return "Older";
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The filter under the header: both kinds, or one. The pick is kept in localStorage.
const KINDS = [
  { id: "all", label: "All", tip: "Claude and Codex sessions", keep: () => true },
  { id: "claude", label: "Claude", tip: "claude · claude2 · claude3", keep: (s) => s.kind === "claude" },
  { id: "codex", label: "Codex", tip: "codex · codex2 – codex5", keep: (s) => s.kind === "codex" },
];
function savedFilter() {
  try {
    const id = localStorage.getItem("filter");
    return KINDS.some((f) => f.id === id) ? id : "all";
  } catch {
    return "all";
  }
}

// Sessions hidden from the list (keys, kept in shared state; the menu adds and removes them).
const HIDDEN = "sessions.hidden.herdr";
const HIDDEN_GROUP = "Hidden";
const ICON = { claude: "icons/claude.svg", codex: "icons/codex.svg" };
// For the tab strip over the session panels (pixel-session-tabs): the terminals of this list's
// sessions open in a Herdr tab, and how many sessions it lists (hidden ones left out).
const OPEN = "sessions.open.herdr";

// Any Claude account resumes a transcript by its path and writes on there. The main account is
// the Claude desktop app's login, so it resumes with Remote Control and shows in the app's list
// under its title (claude2/claude3 are other logins and can't).
function claudeArgv(s, account, fork) {
  const argv = [account.cmd, "--resume", s.path];
  if (fork) argv.push("--fork-session");
  if (s.perm === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else if (s.perm && s.perm !== "default") argv.push("--permission-mode", s.perm);
  if (account.main) argv.push("--remote-control", fork ? `${s.title || "Herdr session"} (copy)` : s.title || "Herdr session");
  return argv;
}

// Another Codex account keeps its own login but reads the thread from its owner's databases
// (sqlite_home), with a model its plan offers. Under Herdr, Codex runs without the shared daemon;
// codex2..codex5 pass --no-daemon themselves.
function codexArgv(s, account, verb) {
  const argv = [account.cmd];
  if (account.main) argv.push("--no-daemon");
  argv.push(verb, s.id);
  if (account.name !== s.account && s.home) {
    argv.push("-c", `sqlite_home=${s.home.replace(/\\/g, "/")}`);
    const plan = (shared("sessions.codex")?.accounts ?? []).find((a) => a.name === account.name);
    if (plan?.models?.length && !plan.models.includes(s.model) && plan.best) argv.push("-m", plan.best);
  }
  if (s.sandbox === "disabled") argv.push("-s", "danger-full-access");
  if (s.approval === "never" || s.approval === "on-request") argv.push("-a", s.approval);
  return argv;
}

// Idle: a ring; working: the spinner; blocked and done: a dot in their color; not open: room only.
function dot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).when(Boolean(t[status]), (el) => el.bg(t[status]));
}

export default class HerdrSessions extends View {
  init(_props, cx) {
    this.sessions = null;
    this.accounts = { claude: [], codex: [] };
    this.error = null;
    this.busy = false;
    this.spin = true;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.filter = savedFilter();
    this.scope = localStorage.getItem("scope") ?? "space";
    this.width = null;
    this.sorting = false;
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
    this.sortSpaces(cx);
    cx.timer.every(60000, (cx) => this.sortSpaces(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const req = shared(REQUEST);
        // A pick waits for the list (the tab strip hands it on again).
        if (!String(command).endsWith("request") || !req || !this.sessions) continue;
        setShared(REQUEST, null);
        const s = (this.sessions ?? []).find((x) => x.key === req.id);
        if (s) req.what === "menu" ? this.menu(s) : this.open(s);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/herdr-sessions/list.py`], { timeout: 25000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `list.py exited with ${r.code}`);
        const data = JSON.parse(r.stdout);
        this.sessions = data.sessions;
        this.accounts = data.accounts ?? this.accounts;
        this.error = null;
        const all = terminals();
        this.shareOpen((s) => this.liveTerminal(s, all));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.spin = false;
      cx.notify();
    });
  }

  // Sorts every panel's sessions into spaces (the first run reads all transcripts, ~20 s; later
  // ones only what was added) and shares the answer when it changed. A failure keeps the last one.
  sortSpaces(cx) {
    if (this.sorting) return;
    this.sorting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/herdr-sessions/spaces.py`], { timeout: 180000 });
        if (r.code === 0) {
          const data = JSON.parse(r.stdout);
          const next = { spaces: data.spaces, map: data.map, ...(data.all ? { all: data.all } : {}) };
          if (JSON.stringify(shared(SPACES)) !== JSON.stringify(next)) setShared(SPACES, next);
        }
      } catch {}
      this.sorting = false;
      cx.notify();
    });
  }

  // Shares OPEN when it changed; `term` gives a session's live terminal.
  shareOpen(term) {
    if (!this.sessions) return;
    const hiddenKeys = new Set(shared(HIDDEN) ?? []);
    const kept = this.sessions.filter((s) => !hiddenKeys.has(s.key));
    const next = { terminals: [...new Set(kept.map((s) => term(s)?.address).filter(Boolean))].sort(), listed: kept.length };
    if (JSON.stringify(shared(OPEN)) !== JSON.stringify(next)) setShared(OPEN, next);
  }

  fold(label) {
    this.folded.has(label) ? this.folded.delete(label) : this.folded.add(label);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
  }

  setFilter(id) {
    this.filter = id;
    try {
      localStorage.setItem("filter", id);
    } catch {}
  }

  setScope(id) {
    this.scope = id;
    try {
      localStorage.setItem("scope", id);
    } catch {}
  }

  // The live terminal still running this session, if any.
  liveTerminal(s, all) {
    return s.current ? all.find((k) => k.address === s.terminal && k.state === "live") : null;
  }

  owner(s) {
    return (this.accounts[s.kind] ?? []).find((a) => a.name === s.account) ?? { name: s.account, cmd: s.account, main: false };
  }

  // What opening the session with an account does: go to its tab, or resume it in a new one.
  action(s, account, fork = false) {
    if (!fork && this.liveTerminal(s, terminals())) {
      const p = panes().find((p) => p.terminal === s.terminal);
      return p ? { focus: p.pane } : { focusTerminal: s.terminal };
    }
    if (s.kind === "claude" && !s.path) return { problem: "This PC has no transcript (.jsonl) for it." };
    if (!s.folder) return { problem: `Working folder is missing: ${s.cwd ?? ""}` };
    const title = s.title || "(untitled)";
    const name = fork ? `${title} (copy)` : account.name === s.account ? title : `${title} · ${account.name}`;
    const argv = s.kind === "claude" ? claudeArgv(s, account, fork) : codexArgv(s, account, fork ? "fork" : "resume");
    return { tab: { name, folder: s.cwd, argv }, key: s.key };
  }

  perform(action) {
    if (action.problem) return notify({ title: "Can't open this session", body: action.problem, level: "warning" });
    if (action.focus) return run("pane.focus", { pane: action.focus });
    if (action.focusTerminal) return run("pane.focus", { terminal: action.focusTerminal });
    if (action.tab) return openTab(action.tab, action.key);
  }

  open(s) {
    this.perform(this.action(s, this.owner(s)));
  }

  menu(s) {
    const usable = (action) => (action.problem || action.focusTerminal ? null : action);
    const mails = new Map((shared(`sessions.${s.kind}`)?.accounts ?? []).map((a) => [a.name, a.email || ""]));
    const kind = s.kind === "claude" ? "Claude" : "Codex";
    const groups = [{
      label: `Continue with a ${kind} account`,
      items: (this.accounts[s.kind] ?? []).map((a) => ({
        label: a.name,
        note: [a.name === s.account ? "made it" : null, mails.get(a.name)].filter(Boolean).join(" · "),
        action: usable(this.action(s, a)),
      })),
    }];
    groups.push({
      label: "Copy",
      items: [{ label: "Open a copy", note: "A new session from this one; the original stays as it is", action: usable(this.action(s, this.owner(s), true)) }],
    });
    const hidden = (shared(HIDDEN) ?? []).includes(s.key);
    groups.push({
      label: "List",
      items: [hidden
        ? { label: "Show again", note: "Back from Hidden to its place", action: { hide: { key: HIDDEN, id: s.key, hidden: false } } }
        : { label: "Hide from panel", note: "Collects it under 'Hidden' at the bottom", action: { hide: { key: HIDDEN, id: s.key, hidden: true } } }],
    });
    if (sortedSpaces().length) groups.push(spaceGroup(s.key));
    const rows = groups.reduce((n, g) => n + g.items.length, 0);
    openOverlay({ mod: "session-menu", kind: "popup", width: 320, height: 40 + groups.length * 26 + rows * 32, props: { menu: { title: s.title || "(untitled)", groups } } });
  }

  render(cx) {
    const t = theme();
    const rail = narrow();
    const now = Date.now();
    const all = terminals();
    const live = new Map(agents().map((a) => [a.address, a]));
    const hiddenKeys = new Set(shared(HIDDEN) ?? []);
    const filter = KINDS.find((f) => f.id === this.filter) ?? KINDS[0];
    // The shown space's sessions, and the ones open in its tabs; unsorted ones fold at the bottom.
    const shownSorted = shownSpace();
    const every = everySpace();
    const here = this.scope === "all" || every ? null : shownSorted;
    const term = once((s) => this.liveTerminal(s, all));
    this.shareOpen(term);
    const spaceIn = spaceLookup();
    // The all-space has what any space lists: sorted into one, or open in a Herdr tab.
    const inHere = once((s) => (every ? Boolean(spaceIn(s.key) || term(s)) : !here || spaceIn(s.key) === here.name || term(s)?.labels?.["herdr.space"] === here.id));
    const loose = (s) => Boolean(here || every) && !inHere(s) && !spaceIn(s.key);
    const listed = (this.sessions ?? []).filter((s) => !hiddenKeys.has(s.key) && inHere(s));
    const list = listed.filter(filter.keep);
    const unsorted = (this.sessions ?? []).filter((s) => !hiddenKeys.has(s.key) && loose(s) && filter.keep(s));
    const hidden = (this.sessions ?? []).filter((s) => hiddenKeys.has(s.key) && (every || inHere(s)) && filter.keep(s));

    const row = (s) => {
      const k = term(s);
      const a = k && live.get(k.address);
      const off = !k && (!s.folder || (s.kind === "claude" && !s.path));
      const tip = [
        s.cwd,
        every ? `Space: ${spaceIn(s.key) ?? "not sorted"}` : null,
        `${s.kind === "claude" ? "Claude" : "Codex"} · ${s.account}${s.opened_with && s.opened_with !== s.account ? ` (last opened with ${s.opened_with})` : ""}`,
        k ? `Open in a Herdr tab: ${s.where || k.address}` : s.where ? `Was in: ${s.where}` : null,
        "Right-click: another account, a copy, or hide",
      ].filter(Boolean).join("\n");
      const right = (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(s);
      });
      if (rail) {
        return right(h_flex()
          .id(`hs-${s.key}`)
          .h(26)
          .flex_none()
          .items_center()
          .justify_center()
          .hover((el) => el.bg(t.hover))
          .tooltip(`${s.title}\n${tip}`)
          .on_click(() => this.open(s))
          .child(a ? dot(t, a.status) : image(ICON[s.kind]).w(12).h(12).flex_none()));
      }
      return right(h_flex()
        .id(`hs-${s.key}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(7)
        .when(Boolean(a?.focused), (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(tip)
        .on_click(() => this.open(s))
        .child(dot(t, a?.status))
        .child(image(ICON[s.kind]).w(12).h(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(off ? t.dim : t.foreground).child(s.title || "(untitled)"))
        // In the all-space the chip names the session's space (the account stays in the tooltip).
        .when(!every, (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).flex().items_center().child(s.account)))
        .when(Boolean(every && spaceIn(s.key)), (el) => el.child(div().flex_none().max_w(52).truncate().text_size(10).text_color(t.muted).child(spaceIn(s.key))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - (s.last ?? 0)))));
    };

    // Date groups in list order; a header folds its group and, folded, says how many.
    const groups = [];
    for (const s of list) {
      const label = group(s.last ?? 0, now);
      if (groups.at(-1)?.label === label) groups.at(-1).members.push(s);
      else groups.push({ label, members: [s] });
    }
    if (unsorted.length) groups.push({ label: NOT_SORTED, members: unsorted });
    if (hidden.length) groups.push({ label: HIDDEN_GROUP, members: hidden });
    // The hidden and not-sorted groups start folded; the others start open.
    const startsFolded = (label) => label === HIDDEN_GROUP || label === NOT_SORTED;
    const isFolded = (label) => (startsFolded(label) ? !this.folded.has(`${label}:open`) : this.folded.has(label));
    const header = (g, i) => {
      const open = !isFolded(g.label);
      return h_flex()
        .id(`hs-group-${i}`)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .text_color(t.dim)
        .cursor_pointer()
        .hover((el) => el.text_color(t.foreground))
        .when(g.label === NOT_SORTED, (el) => el.tooltip("Sessions with too few words to sort, and in no known folder.\nRight-click one to pick its space."))
        .on_click((_e, cx) => {
          this.fold(startsFolded(g.label) ? `${g.label}:open` : g.label);
          cx.notify();
        })
        .child(div().truncate().child(g.label))
        .when(!open, (el) => el.child(div().child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none()));
    };
    const rows = rail ? list.map(row) : groups.flatMap((g, i) => [header(g, i), ...(isFolded(g.label) ? [] : g.members.map(row))]);

    // A slim row of the filters, each with how many sessions it has (left out when too narrow).
    const filterBar = () => {
      const counts = KINDS.map((f) => listed.filter(f.keep).length);
      const need = 27 + KINDS.reduce((n, f, i) => n + 15 + 6.5 * f.label.length + 6 * String(counts[i]).length, 0);
      const numbers = this.width == null || this.width >= need;
      return h_flex()
        .px(11)
        .h(18)
        .flex_none()
        .gap(2)
        .items_center()
        .overflow_hidden()
        .children(KINDS.map((f, i) => {
          const on = f === filter;
          return h_flex()
            .id(`hs-filter-${f.id}`)
            .px(5)
            .h(16)
            .flex_none()
            .gap(3)
            .items_center()
            .rounded(4)
            .text_size(11)
            .font_medium()
            .text_color(on ? t.foreground : t.dim)
            .when(on, (el) => el.bg(t.raised))
            .cursor_pointer()
            .hover((el) => el.text_color(t.foreground))
            .tooltip(`${f.tip} · ${counts[i]}`)
            .on_click((_e, cx) => {
              this.setFilter(f.id);
              cx.notify();
            })
            .child(div().child(f.label))
            .when(numbers, (el) => el.child(div().text_size(10).text_color(t.dim).child(String(counts[i]))));
        }));
    };

    // The header chip: the shown space (its sessions only) or every space; a click switches.
    const scopeChip = () => {
      const on = Boolean(here);
      return div()
        .id("hs-scope")
        .mr(8)
        .px(5)
        .h(16)
        .flex_none()
        .flex()
        .items_center()
        .rounded(4)
        .bg(t.raised)
        .text_size(10.5)
        .font_medium()
        .text_color(on || every ? t.foreground : t.dim)
        .when(Boolean(every), (el) => el.tooltip(`${every.name}: every space's sessions in one list, each row naming its space\nNot sorted ones fold at the bottom`))
        .when(!every, (el) => el
          .cursor_pointer()
          .hover((el) => el.text_color(t.foreground))
          .tooltip(on ? `Sessions sorted into ${shownSorted.name}, and any open in its tabs\nClick: every space` : `Every space's sessions\nClick: only ${shownSorted.name}'s`)
          .on_click((_e, cx) => {
            this.setScope(on ? "all" : "space");
            cx.notify();
          }))
        .child(on ? shownSorted.name : "All spaces");
    };

    const note = (text, color) => div().px(16).py(4).text_size(12).text_color(color).child(text);
    return v_flex()
      .id("hs-root")
      .on_size_change((size, cx) => {
        if (this.width === size.width) return;
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!rail, (el) => el
        .child(h_flex()
          .px(16)
          .h(41)
          .pt(14)
          .pb(5)
          .flex_none()
          .items_center()
          .justify_between()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Herdr sessions"))
          .when(Boolean(shownSorted || every), (el) => el.child(scopeChip()))
          .child(div()
            .id("hs-search")
            .mr(10)
            .text_color(t.dim)
            .hover((el) => el.text_color(t.foreground))
            .tooltip("Find a session (Ctrl+Shift+S)")
            .on_click(() => {
              setShared("sessions.search.kind", "herdr");
              run("mod.open", { name: "session-search" });
            })
            .child(svg("mods/workspace-chrome/search.svg").size(13)))
          .child(this.spin
            ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
            : div()
              .id("hs-refresh")
              .text_color(t.dim)
              .hover((el) => el.text_color(t.foreground))
              .tooltip("Refresh")
              .on_click((_e, cx) => {
                this.spin = true;
                this.refresh(cx);
                cx.notify();
              })
              .child(svg("mods/claude-sessions/refresh.svg").size(13))))
        .child(filterBar())
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)))
        .when(this.sessions?.length === 0, (el) => el.child(note("No sessions started in Herdr yet.", t.dim)))
        .when(Boolean(here) && this.sessions?.length > 0 && listed.length === 0, (el) => el.child(note(`No sessions sorted into ${here.name}.`, t.dim)))
        .when(listed.length > 0 && list.length === 0, (el) => el.child(note(`No ${filter.label} sessions.`, t.dim))))
      .child(v_flex().id("hs-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
