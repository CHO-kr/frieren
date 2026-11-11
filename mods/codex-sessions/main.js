// Codex app threads (ChatGPT/Codex desktop), pinned first and then newest first. A click
// resumes one in a new tab with the thread's sandbox and approvals; Codex restores its model
// itself and, for a thread another app holds, offers retry or fork on its own screen.
// A right click offers the other Codex accounts and Claude.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, terminals, agents, run, theme, notify, appHome, layout, openOverlay, shared, setShared, nextCommand } from "herdr";

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

// Another account keeps its own login but reads this account's threads from its databases
// (sqlite_home), and gets a model its plan offers when the thread's own isn't.
function argvFor(s, account, home, verb = "resume") {
  const argv = [account.cmd, verb, s.id];
  if (!account.main) {
    argv.push("-c", `sqlite_home=${home.replace(/\\/g, "/")}`);
    if (account.models?.length && !account.models.includes(s.model) && account.best) argv.push("-m", account.best);
  }
  if (s.sandbox === "disabled") argv.push("-s", "danger-full-access");
  if (s.approval === "never" || s.approval === "on-request") argv.push("-a", s.approval);
  return argv;
}

const MAIN = { name: "codex", cmd: "codex", main: true };

// Threads hidden from the list (ids, kept in shared state; the menu adds and removes them).
const HIDDEN = "sessions.hidden.codex";
const HIDDEN_GROUP = "Hidden";
const REQUEST = "sessions.request.codex";

// A tab started here runs `& 'codex' 'resume' '<id>' ...` in its shell, so the id finds it.
const terminalFor = (s, all) =>
  all.find((k) => k.state === "live" && k.labels?.["herdr.space"] && (k.argv ?? []).some((a) => String(a).includes(s.id)));

// Idle: a ring; working: the spinner; blocked and done: a dot in their color; not open: room only.
function dot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).when(Boolean(t[status]), (el) => el.bg(t[status]));
}

export default class CodexSessions extends View {
  init(_props, cx) {
    this.threads = null;
    this.accounts = [MAIN];
    this.home = "";
    this.error = null;
    this.busy = false;
    this.spin = true;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.refresh(cx);
    cx.timer.every(60000, (cx) => this.refresh(cx));
    // The session-search window hands its pick here, to open as if clicked in this list.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const req = shared(REQUEST);
        if (!String(command).endsWith("request") || !req) continue;
        setShared(REQUEST, null);
        const s = (this.threads ?? []).find((x) => x.id === req.id);
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
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/codex-sessions/list.py`]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `list.py exited with ${r.code}`);
        const data = JSON.parse(r.stdout);
        this.threads = data.threads;
        this.accounts = data.accounts?.length ? data.accounts : [MAIN];
        this.home = data.home;
        // The Claude panel's menu offers these accounts too.
        const mine = { home: this.home, accounts: this.accounts };
        if (JSON.stringify(shared("sessions.codex")) !== JSON.stringify(mine)) setShared("sessions.codex", mine);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.spin = false;
      cx.notify();
    });
  }

  fold(label) {
    this.folded.has(label) ? this.folded.delete(label) : this.folded.add(label);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
  }

  // What opening the thread with an account does: go to its tab, ask first, or open it.
  // This account's Codex checks the app's lock itself; another one can't see it, so we ask.
  action(s, account) {
    const k = terminalFor(s, terminals());
    const a = k && agents().find((a) => a.address === k.address);
    if (a) return { focus: a.pane };
    if (!s.folder) return { problem: `Working folder is missing: ${s.cwd ?? ""}` };
    const name = account.main ? s.title : `${s.title} · ${account.name}`;
    const tab = { name, folder: s.cwd, argv: argvFor(s, account, this.home) };
    if (account.main || !s.open) return { tab };
    return {
      confirm: {
        heading: "Task open somewhere else",
        body: `‘${s.title}’ is open in the desktop app or another terminal. ${account.name} can't tell, so using both in turn can mix up the history.`,
        hint: "Continue: stop typing in the other place. Copy: forks into a new task, so neither affects the other.",
        actions: [
          { label: "Cancel", action: null },
          { label: "Open a copy", action: { tab: { name: `${name} (copy)`, folder: s.cwd, argv: argvFor(s, account, this.home, "fork") } } },
          { label: `Continue as ${account.name}`, primary: true, action: { tab } },
        ],
      },
    };
  }

  // The panel does the simple ones itself; a question goes to the session-menu dialog.
  perform(action) {
    if (action.problem) return notify({ title: "Can't open this task", body: action.problem, level: "warning" });
    if (action.focus) return run("pane.focus", { pane: action.focus });
    if (action.tab) return run("tab.new", action.tab);
    openOverlay({ mod: "session-menu", kind: "dialog", width: 420, height: 236, props: { confirm: action.confirm } });
  }

  open(s) {
    this.perform(this.action(s, this.accounts.find((a) => a.main) ?? MAIN));
  }

  menu(s) {
    const usable = (action) => (action.problem ? null : action);
    const mail = (a) => a.email || "";
    const model = (a) => (a.main || !a.models?.length || a.models.includes(s.model) ? s.model : a.best) ?? "";
    const groups = [{
      label: "Continue with a Codex account",
      items: this.accounts.map((a) => ({ label: a.name, note: `${mail(a)} · ${model(a)}`, action: usable(this.action(s, a)) })),
    }];
    const claude = shared("sessions.claude");
    if (s.folder && claude?.accounts?.length) {
      groups.push({
        label: s.link ? "Hand over to Claude · continue the paired session" : "Hand over to Claude · as a new session",
        items: claude.accounts.map((a) => ({
          label: a.name,
          note: mail(a),
          action: { toClaude: { thread: s.id, bypass: s.sandbox === "disabled" && s.approval === "never", account: a } },
        })),
      });
    }
    const hidden = (shared(HIDDEN) ?? []).includes(s.id);
    groups.push({
      label: "List",
      items: [hidden
        ? { label: "Show again", note: "Back from Hidden to its place", action: { hide: { key: HIDDEN, id: s.id, hidden: false } } }
        : { label: "Hide from panel", note: "Collects it under 'Hidden' at the bottom", action: { hide: { key: HIDDEN, id: s.id, hidden: true } } }],
    });
    const rows = groups.reduce((n, g) => n + g.items.length, 0);
    openOverlay({ mod: "session-menu", kind: "popup", width: 320, height: 40 + groups.length * 26 + rows * 32, props: { menu: { title: s.title, groups } } });
  }

  render(cx) {
    const t = theme();
    const rail = narrow();
    const now = Date.now();
    const all = terminals();
    const live = new Map(agents().map((a) => [a.address, a]));
    const hiddenIds = new Set(shared(HIDDEN) ?? []);
    const list = (this.threads ?? []).filter((s) => !hiddenIds.has(s.id));
    const hidden = (this.threads ?? []).filter((s) => hiddenIds.has(s.id));

    const row = (s) => {
      const k = terminalFor(s, all);
      const a = k && live.get(k.address);
      // A held lock with no tab of ours: the desktop app or another terminal has it.
      const elsewhere = s.open && !k;
      const tip = [s.cwd, `${s.model ?? ""} · ${s.effort ?? ""}`, s.pin != null ? "Pinned" : null,
        s.link ? `⇄ Paired with Claude session «${s.link.title}»: each handover adds to both` : null, elsewhere ? "Open elsewhere (desktop app or another terminal)" : null, a ? "Open in a Herdr tab" : null, "Right-click: open with another account or in Claude"]
        .filter(Boolean)
        .join("\n");
      const right = (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(s);
      });
      if (rail) {
        return right(h_flex()
          .id(`cx-${s.id}`)
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
        .id(`cx-${s.id}`)
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
        .child(div().flex_1().min_w(0).truncate().text_color(s.folder ? t.foreground : t.dim).child(s.title || "(untitled)"))
        .when(Boolean(s.link), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("⇄")))
        .when(elsewhere, (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).flex().items_center().child("open")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - (s.last ?? 0)))));
    };

    // Pinned in the app's order, then date groups in list order. A header folds its group
    // and, folded, says how many.
    const pinned = list.filter((s) => s.pin != null).sort((x, y) => x.pin - y.pin);
    const groups = pinned.length ? [{ label: "Pinned", members: pinned }] : [];
    for (const s of list) {
      if (s.pin != null) continue;
      const label = group(s.last ?? 0, now);
      if (groups.at(-1)?.label === label) groups.at(-1).members.push(s);
      else groups.push({ label, members: [s] });
    }
    if (hidden.length) groups.push({ label: HIDDEN_GROUP, members: hidden });
    // The hidden group starts folded; the others start open.
    const isFolded = (label) => (label === HIDDEN_GROUP ? !this.folded.has(`${HIDDEN_GROUP}:open`) : this.folded.has(label));
    const header = (g, i) => {
      const open = !isFolded(g.label);
      return h_flex()
        .id(`cx-group-${i}`)
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
        .on_click((_e, cx) => {
          this.fold(g.label === HIDDEN_GROUP ? `${HIDDEN_GROUP}:open` : g.label);
          cx.notify();
        })
        .child(div().truncate().child(g.label))
        .when(!open, (el) => el.child(div().child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none()));
    };
    const rows = rail ? list.map(row) : groups.flatMap((g, i) => [header(g, i), ...(isFolded(g.label) ? [] : g.members.map(row))]);

    const note = (text, color) => div().px(16).py(4).text_size(12).text_color(color).child(text);
    return v_flex()
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
          .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Codex sessions"))
          .child(div()
            .id("cx-search")
            .mr(10)
            .text_color(t.dim)
            .hover((el) => el.text_color(t.foreground))
            .tooltip("Find a session (Ctrl+Shift+S)")
            .on_click(() => {
              setShared("sessions.search.kind", "codex");
              run("mod.open", { name: "session-search" });
            })
            .child(svg("mods/workspace-chrome/search.svg").size(13)))
          .child(this.spin
            ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
            : div()
              .id("cx-refresh")
              .text_color(t.dim)
              .hover((el) => el.text_color(t.foreground))
              .tooltip("Refresh")
              .on_click((_e, cx) => {
                this.spin = true;
                this.refresh(cx);
                cx.notify();
              })
              .child(svg("mods/codex-sessions/refresh.svg").size(13))))
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)))
        .when(this.threads?.length === 0, (el) => el.child(note("No Codex app sessions.", t.dim))))
      .child(v_flex().id("cx-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
