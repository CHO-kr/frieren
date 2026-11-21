// Claude desktop app sessions, newest first. A click resumes one in a new tab with the app's
// own model, effort and permission mode; a right click offers the other accounts and Codex.
// One the app still runs asks first.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, terminals, agents, spaces, run, theme, notify, appHome, layout, openOverlay, shared, setShared, nextCommand } from "herdr";

// Spaces. herdr-sessions/spaces.py sorts every session into one of the spaces in spaces.json
// (none: no sorting, every session listed); the Herdr sessions panel shares the answer as "sessions.spaces"
// ({spaces: [{name, folder, about}], map: {"claude:<id>" | "codex:<id>": name}}), and a pick in
// the right-click menu ("sessions.space.assign", {key: name}) wins. While one of those spaces is
// shown, the list keeps its sessions and any open in its tabs; unsorted ones fold under "Not
// sorted". A session opens in its space. The same few lines are in the Codex, Herdr and menu mods.
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

// The date filter under the header keeps whole date groups, so it agrees with their headers.
// Sessions open in a Herdr tab show under every filter. The pick is kept in localStorage.
const FILTERS = [
  { id: "all", label: "All", tip: "All sessions", keep: () => true },
  { id: "7d", label: "7d", tip: "Last 7 days", empty: "in the last 7 days", keep: (g) => g === "Today" || g === "Yesterday" || g === "Last 7 days" },
  { id: "30d", label: "30d", tip: "Last 30 days", empty: "in the last 30 days", keep: (g) => g !== "Older" },
  { id: "older", label: "Older", tip: "Older than 30 days", empty: "older than 30 days", keep: (g) => g === "Older" },
];
function savedFilter() {
  try {
    const id = localStorage.getItem("filter");
    return FILTERS.some((f) => f.id === id) ? id : "all";
  } catch {
    return "all";
  }
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Any account resumes the transcript by its path and writes on there (a session made by a move
// from Codex may live in another account's folder).
function argvFor(s, account, fork) {
  const argv = [account.cmd, "--resume", s.path];
  if (fork) argv.push("--fork-session");
  if (s.model) argv.push("--model", s.model);
  if (s.effort) argv.push("--effort", s.effort);
  if (s.perm === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else if (s.perm && s.perm !== "default") argv.push("--permission-mode", s.perm);
  return argv;
}

// A tab started here runs `& 'claude' '--resume' '<id or path>' ...` in its shell, so the id finds it.
// A session forked in a Herdr tab has a new id; the Herdr sessions panel says which tab runs it.
const terminalFor = (s, all) =>
  all.find((k) => k.state === "live" && k.labels?.["herdr.space"] && (k.argv ?? []).some((a) => String(a).includes(s.cli))) ??
  (s.current && s.terminal ? all.find((k) => k.state === "live" && k.address === s.terminal) : undefined);

const MAIN = { name: "claude", cmd: "claude", main: true };

// Sessions hidden from the list (ids, kept in shared state; the menu adds and removes them).
const HIDDEN = "sessions.hidden.claude";
const HIDDEN_GROUP = "Hidden";
const REQUEST = "sessions.request.claude";
// For the tab strip over the session panels (pixel-session-tabs): the terminals of this list's
// sessions open in a Herdr tab, and how many sessions it lists (hidden ones left out).
const OPEN = "sessions.open.claude";

// Idle: a ring; working: the spinner; blocked and done: a dot in their color; not open: room only.
function dot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).when(Boolean(t[status]), (el) => el.bg(t[status]));
}

export default class ClaudeSessions extends View {
  init(_props, cx) {
    this.sessions = null;
    this.accounts = [MAIN];
    this.error = null;
    this.fails = 0;
    this.busy = false;
    this.spin = true;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.filter = savedFilter();
    this.scope = localStorage.getItem("scope") ?? "space";
    this.width = null;
    this.refresh(cx);
    cx.timer.every(60000, (cx) => this.refresh(cx));
    // The session-search window hands its pick here, to open as if clicked in this list.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const req = shared(REQUEST);
        // A pick waits for the list (the tab strip hands it on again).
        if (!String(command).endsWith("request") || !req || !this.sessions) continue;
        setShared(REQUEST, null);
        const s = (this.sessions ?? []).find((x) => x.cli === req.id);
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
        // list.ps1 takes 2-4 s, but PowerShell 5.1 can stall past exec's default 30 s while the
        // PC is busy (2026-11-17), so it gets two minutes.
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/claude-sessions/list.ps1`], { timeout: 120000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `list.ps1 exited with ${r.code}`);
        const data = JSON.parse(r.stdout);
        this.sessions = data.sessions.filter((s) => !s.archived);
        this.accounts = data.accounts?.length ? data.accounts : [MAIN];
        // The Codex panel's menu offers these accounts too.
        if (JSON.stringify(shared("sessions.claude")?.accounts) !== JSON.stringify(this.accounts)) setShared("sessions.claude", { accounts: this.accounts });
        this.error = null;
        const all = terminals();
        this.shareOpen((s) => terminalFor(s, all));
        this.fails = 0;
      } catch (e) {
        // One failed refresh keeps the last list quietly; the error shows when the next one fails
        // too, or when there is no list yet.
        this.fails += 1;
        if (this.fails >= 2 || !this.sessions) this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.spin = false;
      cx.notify();
    });
  }

  // Shares OPEN when it changed; `term` gives a session's live terminal.
  shareOpen(term) {
    if (!this.sessions) return;
    const hiddenIds = new Set(shared(HIDDEN) ?? []);
    const kept = this.sessions.filter((s) => !hiddenIds.has(s.cli));
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

  // What opening the session with an account does: go to its tab, ask first, or open it.
  action(s, account) {
    const k = terminalFor(s, terminals());
    const a = k && agents().find((a) => a.address === k.address);
    if (a) return { focus: a.pane };
    if (!s.resumable) return { problem: "This PC has no transcript (.jsonl) for it." };
    if (!s.folder) return { problem: `Working folder is missing: ${s.cwd ?? ""}` };
    const key = `claude:${s.cli}`;
    const name = account.main ? s.title : `${s.title} · ${account.name}`;
    const tab = { name, folder: s.cwd, argv: argvFor(s, account, false) };
    if (!s.desktop) return { tab, key };
    return {
      confirm: {
        heading: "Session also open in the desktop app",
        body: `‘${s.title}’ is also open in the Claude desktop app. Typing in both places splits the conversation.`,
        hint: "Continue: stop typing in the desktop app. Copy: forks into a new session, so neither affects the other.",
        actions: [
          { label: "Cancel", action: null },
          { label: "Open a copy", action: { tab: { name: `${name} (copy)`, folder: s.cwd, argv: argvFor(s, account, true) }, key } },
          { label: `Continue as ${account.name}`, primary: true, action: { tab, key } },
        ],
      },
    };
  }

  // The panel does the simple ones itself; a question goes to the session-menu dialog.
  perform(action) {
    if (action.problem) return notify({ title: "Can't open this session", body: action.problem, level: "warning" });
    if (action.focus) return run("pane.focus", { pane: action.focus });
    if (action.tab) return openTab(action.tab, action.key);
    openOverlay({ mod: "session-menu", kind: "dialog", width: 420, height: 236, props: { confirm: action.confirm } });
  }

  open(s) {
    this.perform(this.action(s, this.accounts.find((a) => a.main) ?? MAIN));
  }

  menu(s) {
    const usable = (action) => (action.problem ? null : action);
    const mail = (a) => a.email || "";
    const groups = [{
      label: "Continue with a Claude account",
      items: this.accounts.map((a) => ({ label: a.name, note: mail(a), action: usable(this.action(s, a)) })),
    }];
    const hidden = (shared(HIDDEN) ?? []).includes(s.cli);
    const codex = shared("sessions.codex");
    if (s.resumable && s.folder && codex?.accounts?.length) {
      groups.push({
        label: s.link ? "Hand over to Codex · continue the paired task" : "Hand over to Codex · as a new task",
        items: codex.accounts.map((c) => ({
          label: c.name,
          note: c.main ? mail(c) : `${mail(c)} · ${c.best ?? ""}`,
          action: { toCodex: { path: s.path, cwd: s.cwd, title: s.title, perm: s.perm, account: c, home: codex.home } },
        })),
      });
    }
    groups.push({
      label: "List",
      items: [hidden
        ? { label: "Show again", note: "Back from Hidden to its place", action: { hide: { key: HIDDEN, id: s.cli, hidden: false } } }
        : { label: "Hide from panel", note: "Collects it under 'Hidden' at the bottom", action: { hide: { key: HIDDEN, id: s.cli, hidden: true } } }],
    });
    if (sortedSpaces().length) groups.push(spaceGroup(`claude:${s.cli}`));
    const rows = groups.reduce((n, g) => n + g.items.length, 0);
    openOverlay({ mod: "session-menu", kind: "popup", width: 300, height: 40 + groups.length * 26 + rows * 32, props: { menu: { title: s.title, groups } } });
  }

  render(cx) {
    const t = theme();
    const rail = narrow();
    const now = Date.now();
    const all = terminals();
    const live = new Map(agents().map((a) => [a.address, a]));
    const hiddenIds = new Set(shared(HIDDEN) ?? []);
    const filter = FILTERS.find((f) => f.id === this.filter) ?? FILTERS[0];
    const term = once((s) => terminalFor(s, all));
    this.shareOpen(term);
    const when = once((s) => group(s.last ?? 0, now));
    const always = (s) => Boolean(term(s));
    const shows = (s) => filter.keep(when(s)) || always(s);
    // The shown space's sessions, and the ones open in its tabs; unsorted ones fold at the bottom.
    const shownSorted = shownSpace();
    const every = everySpace();
    const here = this.scope === "all" || every ? null : shownSorted;
    const spaceIn = spaceLookup();
    const sorted = once((s) => spaceIn(`claude:${s.cli}`));
    // The all-space has what any space lists: sorted into one, or open in a Herdr tab.
    const inHere = once((s) => (every ? Boolean(sorted(s) || term(s)) : !here || sorted(s) === here.name || term(s)?.labels?.["herdr.space"] === here.id));
    const loose = (s) => Boolean(here || every) && !inHere(s) && !sorted(s);
    const listed = (this.sessions ?? []).filter((s) => !hiddenIds.has(s.cli) && inHere(s));
    const list = listed.filter(shows);
    const unsorted = (this.sessions ?? []).filter((s) => !hiddenIds.has(s.cli) && loose(s) && shows(s));
    const hidden = (this.sessions ?? []).filter((s) => hiddenIds.has(s.cli) && (every || inHere(s)) && shows(s));

    const row = (s) => {
      const k = term(s);
      const a = k && live.get(k.address);
      const off = !s.resumable || !s.folder;
      const tip = [s.cwd, every ? `Space: ${sorted(s) ?? "not sorted"}` : null, s.origin === "herdr" ? "Session made in Herdr from a Codex handover"
        : s.origin === "derived" && s.how === "outside" ? `Made outside Herdr, reopened in a Herdr tab · ${s.account ?? ""}`
        : s.origin === "derived" ? `Forked in a Herdr tab${s.parent ? ` from «${s.parent}»` : ""} · ${s.account ?? ""}`
        : `${s.turns ?? 0} turns · ${s.model ?? ""} · ${s.effort ?? ""}`,
        s.link ? `⇄ Paired with Codex task «${s.link.title}»: each handover adds to both` : null,
        s.desktop ? "Open in the desktop app" : null, a ? "Open in a Herdr tab" : null, "Right-click: open with another account or in Codex"]
        .filter(Boolean)
        .join("\n");
      const right = (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(s);
      });
      if (rail) {
        return right(h_flex()
          .id(`cs-${s.cli}`)
          .h(26)
          .flex_none()
          .items_center()
          .justify_center()
          .hover((el) => el.bg(t.hover))
          .tooltip(`${s.title}\n${tip}`)
          .on_click(() => this.open(s))
          .child(dot(t, a?.status)));
      }
      return right(h_flex()
        .id(`cs-${s.cli}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(8)
        .when(Boolean(a?.focused), (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(tip)
        .on_click(() => this.open(s))
        .child(dot(t, a?.status))
        .child(div().flex_1().min_w(0).truncate().text_color(off ? t.dim : t.foreground).child(s.title || "(untitled)"))
        .when(Boolean(s.link), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("⇄")))
        .when(s.desktop, (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).flex().items_center().child("app")))
        .when(Boolean(every && sorted(s)), (el) => el.child(div().flex_none().max_w(52).truncate().text_size(10).text_color(t.muted).child(sorted(s))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - (s.last ?? 0)))));
    };

    // Date groups in list order; a header folds its group and, folded, says how many.
    const groups = [];
    for (const s of list) {
      const label = when(s);
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
        .id(`cs-group-${i}`)
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
      const counts = FILTERS.map((f) => listed.filter((s) => f.keep(when(s))).length);
      const kept = listed.filter(always);
      const extra = FILTERS.map((f) => kept.filter((s) => !f.keep(when(s))).length);
      const need = 27 + FILTERS.reduce((n, f, i) => n + 15 + 6.5 * f.label.length + 6 * String(counts[i]).length, 0);
      const numbers = this.width == null || this.width >= need;
      return h_flex()
        .px(11)
        .h(18)
        .flex_none()
        .gap(2)
        .items_center()
        .overflow_hidden()
        .children(FILTERS.map((f, i) => {
          const on = f === filter;
          return h_flex()
            .id(`cs-filter-${f.id}`)
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
            .tooltip(`${f.tip} · ${counts[i]}${f.empty ? `\nOpen in a Herdr tab: always shown${extra[i] ? ` (+${extra[i]})` : ""}` : ""}`)
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
        .id("cs-scope")
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
      .id("cs-root")
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
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Claude sessions"))
          .when(Boolean(shownSorted || every), (el) => el.child(scopeChip()))
          .child(div()
            .id("cs-search")
            .mr(10)
            .text_color(t.dim)
            .hover((el) => el.text_color(t.foreground))
            .tooltip("Find a session (Ctrl+Shift+S)")
            .on_click(() => {
              setShared("sessions.search.kind", "claude");
              run("mod.open", { name: "session-search" });
            })
            .child(svg("mods/workspace-chrome/search.svg").size(13)))
          .child(this.spin
            ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
            : div()
              .id("cs-refresh")
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
        .when(this.sessions?.length === 0, (el) => el.child(note("No desktop app sessions.", t.dim)))
        .when(Boolean(here) && this.sessions?.length > 0 && listed.length === 0, (el) => el.child(note(`No sessions sorted into ${here.name}.`, t.dim)))
        .when(Boolean(filter.empty) && listed.length > 0 && list.length === 0, (el) => el.child(note(`No sessions ${filter.empty}.`, t.dim))))
      .child(v_flex().id("cs-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
