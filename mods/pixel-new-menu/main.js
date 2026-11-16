// The frieren-pixel + menu: Herdr's new-menu (cloned 2026-11-16) with Claude Code and Codex listed per account, the
// account with the most usage left first with a "most left" note (accounts.js; usage-gauge shares which one).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, checking } from "herdr";
import { agentRows, MOST_LEFT } from "./accounts.js";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";

// What `herdr-app check` renders, so the check covers the account rows and the note.
const SAMPLE = {
  agents: [
    { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"], installed: true },
    { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true, run: ["codex", "--no-daemon"], installed: true },
  ],
  accounts: { claude: [{ name: "claude", cmd: "claude", main: true }, { name: "claude2", cmd: "claude2" }], codex: [{ name: "codex", cmd: "codex", main: true }, { name: "codex2", cmd: "codex2" }] },
  best: { claude: { name: "claude2", used: 10 }, codex: null },
};

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) {
      this.agents = SAMPLE.agents;
      this.sample = SAMPLE;
      return;
    }
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true, note = null, tip = null) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .when(Boolean(tip), el => el.tooltip(tip))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(note), el => el.child(div().flex_none().px(4).border(1).border_color(t.accent).text_size(10.5).text_color(t.accent).child(note)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const installed = this.agents.filter(a => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    // Claude Code and Codex: a row per account, the one with the most usage left first. The accounts' commands
    // (claude2, codex3, ...) are this PC's, so a space on another machine keeps one row per agent.
    const accounts = space?.machine ? null : this.sample?.accounts ?? { claude: shared("sessions.claude")?.accounts, codex: shared("sessions.codex")?.accounts };
    const rows = agentRows(choices, accounts, this.sample?.best ?? shared("usage.roomiest"));
    const startable = rows.filter(r => r.installed);
    const start = (r) => run("tab.new", { name: r.tab, space: space?.id, argv: r.run });
    const tipOf = (r) => (r.account ? `${r.agent} · ${r.account}${r.most ? "\nMost left: start new work here" : ""}` : null);
    return v_flex().min_h(0).w_full().h(Math.min(539, 167 + Math.max(1, rows.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const r = /^[1-9]$/.test(e.key) ? startable[Number(e.key) - 1] : null;
        if (!r) return;
        closeOverlay(props().overlay);
        start(r);
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(rows.map((r) => {
          const n = startable.indexOf(r);
          return this.row(r.key, r.tint ? svg(r.icon).size(14).text_color(t.foreground) : image(r.icon).size(14), r.name,
            () => start(r), r.installed ? (n >= 0 && n < 9 ? String(n + 1) : "") : "not installed", r.installed, r.most ? MOST_LEFT : null, tipOf(r));
        }))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
