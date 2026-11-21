// Pixel chronicle: the party's scribe. Three views of one mod:
//   the layout block (0 px wide, in the top bar): every 2 s it runs chronicle.py with the live agent terminals, which
//       reads each agent's own conversation record (Claude Code transcripts, Codex rollouts) and says, per terminal:
//       how full its context is, the outcomes of its commands and edits, its last test run, whether its last turn ended
//       with a question to the person, and the files it made. Shared as
//         shared("pixel.deeds") = { at, terminals: { <address>: { kind, account, session, model, context: { used, full,
//             pct }, busy, question: { text, at } | null, outcomes: [{ at, ok, what, detail, passed?, failed? }],
//             streak, wounds, hit: { at, what, detail } | null, tests: { at, ok, passed?, failed?, detail } | null,
//             loot: [{ path, at, kind }], prompt } } }
//         shared("pixel.loot") = [{ path, at, kind, terminal }], newest first (the Results panel's "Loot dropped")
//       pixel-party (cards), pixel-pane (headers, battle stage) and results-panel read them. The script also keeps the
//       journey log (journal.jsonl) and notices when the person comes back after 15 minutes away.
//   the "Since you left" window (props.report), opened by the block when the person comes back and something happened.
//   the Journey Log window (any other overlay: mod.open, Ctrl+Shift+J, the party's LOG button): every space's events.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, appHome, home, exec, readTextFile, run, theme, shared, setShared, props, openOverlay,
  closeOverlay, checking } from "herdr";
import { ROSTER, character, facePath, agentKey, isAgentPane, alpha } from "./lib.js";

const SCRIPT = () => `${appHome()}/mods/pixel-chronicle/chronicle.py`;
const JOURNAL = () => `${home()}/AppData/Local/herdr-sessions/journal.jsonl`;
const EVERY = 2000;
const SHOWN = 400; // the journal's newest events the log window lists

// What each kind of event looks like: a badge and its color (theme names or hex)
const KINDS = {
  start: { label: "SET OUT", color: "muted" },
  done: { label: "QUEST", color: "done" },
  question: { label: "ASKS", color: "#ffd35a" },
  help: { label: "HELP!", color: "blocked" },
  tests: { label: "TESTS", color: "done" },
  fail: { label: "HIT", color: "blocked" },
  rage: { label: "RAGE", color: "blocked" },
  loot: { label: "LOOT", color: "#ffc25c" },
  inn: { label: "INN", color: "#86b4ff" },
};
const FILTERS = [
  { id: "all", label: "All", has: () => true },
  { id: "quests", label: "Quests", has: (e) => e.kind === "done" || e.kind === "question" || e.kind === "start" },
  { id: "trouble", label: "Trouble", has: (e) => e.kind === "help" || e.kind === "rage" || e.kind === "fail" || (e.kind === "tests" && !e.ok) },
  { id: "loot", label: "Loot", has: (e) => e.kind === "loot" },
];
const byName = new Map(ROSTER.map((c) => [c.name, c]));
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayOf = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return same(d, today) ? "Today" : same(d, y) ? "Yesterday" : `${d.getMonth() + 1}/${d.getDate()}`;
};
const span = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const parseLines = (text) => String(text ?? "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const isAgentLike = (a) => /claude|codex/i.test(`${a.app ?? ""} ${a.program?.key ?? ""}`);
const openFile = (path) => exec("powershell", ["-NoProfile", "-Command", "& { param($p) Invoke-Item -LiteralPath $p }", path]);

export default class PixelChronicle extends View {
  init(_props, cx) {
    this.filter = "all";
    this.here = false; // the log window: only the shown space
    this.events = null;
    this.running = false;
    this.lastDeeds = null;
    this.lastLoot = null;
    if (props()?.overlay) {
      if (!props()?.report) this.loadLog(cx);
      return;
    }
    if (checking()) return;
    cx.timer.every(EVERY, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // ---------------------------------------------------------------- the scribe (layout block)
  // The live agent terminals, with the names the journal writes down: space, tab, character.
  termsNow() {
    const where = new Map(spaces().flatMap((s) => (s.tabs ?? []).map((t) => [t.id, { s, t }])));
    const all = agents();
    const picks = shared("journey.party") ?? {};
    const out = {};
    for (const a of all) {
      if (!isAgentLike(a) || a.address.includes("/")) continue;
      out[a.address] = { st: a.status, space: a.space_name, tab: a.tab_name, ch: character(picks[agentKey(a, all)])?.name ?? null };
    }
    // agent panes that report no status to Herdr (pixel-party reads theirs from the screen)
    const known = new Set(all.map((a) => a.address));
    for (const q of panes()) {
      if (!q.terminal || known.has(q.terminal) || !isAgentPane(q) || q.terminal.includes("/")) continue;
      const at = where.get(q.tab);
      out[q.terminal] = { st: shared("pixel.activity")?.[q.terminal]?.status ?? "idle", space: at?.s.name ?? "", tab: at?.t.name ?? "",
        ch: character(picks[`tab:${q.tab}`])?.name ?? null };
    }
    return out;
  }

  tick(cx) {
    if (this.running) return;
    this.running = true;
    const input = JSON.stringify({ terms: this.termsNow() });
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", SCRIPT(), input], { timeout: 60000 });
        const d = JSON.parse(r.stdout || "null");
        if (d) this.take(d);
      } catch {}
      this.running = false;
    });
  }

  take(d) {
    // Context grows with every answer: share it in 1k steps so the panels don't redraw for every token.
    const terminals = {};
    for (const [t, s] of Object.entries(d.terminals ?? {})) {
      terminals[t] = s.context ? { ...s, context: { ...s.context, used: Math.round(s.context.used / 1000) * 1000 } } : s;
    }
    const key = JSON.stringify(terminals);
    if (key !== this.lastDeeds) {
      this.lastDeeds = key;
      setShared("pixel.deeds", { at: d.at, terminals });
    }
    const loot = JSON.stringify(d.loot ?? []);
    if (loot !== this.lastLoot) {
      this.lastLoot = loot;
      setShared("pixel.loot", d.loot ?? []);
    }
    if (d.report?.events?.length) {
      openOverlay({ mod: "pixel-chronicle", kind: "window", key: "since-you-left", width: 620, height: 460, props: { report: d.report } });
    }
  }

  // ---------------------------------------------------------------- the windows
  loadLog(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(JOURNAL()).catch(() => "");
      const lines = String(text ?? "").split(/\r?\n/);
      this.events = parseLines(lines.slice(-SHOWN - 1).join("\n")).reverse();
      cx.notify();
    });
  }

  // Goes to where an event happened: its terminal if it still runs, a loot file opens.
  go(e) {
    if (e.kind === "loot" && e.path) return openFile(e.path);
    if (!e.t) return;
    if (agents().some((a) => a.address === e.t)) run("agent.focus", { terminal: e.t });
    else if (panes().some((q) => q.terminal === e.t)) run("pane.focus", { terminal: e.t });
  }

  color(t, name) {
    return name?.startsWith("#") ? name : t[name] ?? t.muted;
  }

  row(t, e, i, withDay) {
    const k = KINDS[e.kind] ?? { label: e.kind?.toUpperCase() ?? "?", color: "muted" };
    const c = this.color(t, e.kind === "tests" && !e.ok ? "blocked" : k.color);
    const label = e.kind === "tests" ? (e.ok ? "CLEAR" : "WOUNDED") : k.label;
    const ch = byName.get(e.ch) ?? null;
    const live = e.t && (agents().some((a) => a.address === e.t) || panes().some((q) => q.terminal === e.t));
    const where = [e.space, e.tab].filter(Boolean).join(" · ");
    return h_flex().id(`ev-${i}`).w_full().flex_none().h(26).px(8).gap(7).items_center()
      .when(withDay, (el) => el.border_t(1).border_color(alpha(t.border, "30")))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(live || (e.kind === "loot" && e.path)), (el) => el.cursor_pointer().on_click(() => this.go(e)))
      .tooltip([e.text, where, e.path, live ? (e.kind === "loot" ? "Click: open the file" : "Click: go to this member") : e.kind === "loot" ? "Click: open the file" : "Its terminal is closed"]
        .filter(Boolean).join("\n"))
      .child(div().flex_none().w(34).font_family("Galmuri9").text_size(10).text_color(t.dim).child(clock(e.at)))
      .child(ch ? image(facePath(ch)).size(18).flex_none() : div().size(18).flex_none())
      .child(div().flex_none().w(52).truncate().font_family("Galmuri9").text_size(10).text_color(ch?.color ?? t.muted).child(e.ch ?? "—"))
      .child(div().flex_none().px(3).border(1).border_color(c).font_family("Galmuri9").text_size(10).text_color(c).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(e.text ?? ""))
      .child(div().flex_none().max_w(150).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(where));
  }

  list(t, events) {
    let day = null;
    const rows = [];
    events.forEach((e, i) => {
      const d = dayOf(e.at);
      if (d !== day) {
        rows.push(div().id(`day-${i}`).flex_none().px(8).pt(i ? 8 : 2).pb(2).font_family("Galmuri9").text_size(10).text_color(t.accent).child(d));
        day = d;
      }
      rows.push(this.row(t, e, i, false));
    });
    return rows;
  }

  chip(t, id, label, on, click) {
    return div().id(id).flex_none().px(6).h(18).flex().items_center().border(1)
      .border_color(on ? t.accent : alpha(t.border, "80")).when(on, (el) => el.bg(alpha(t.accent, "18")))
      .font_family("Galmuri9").text_size(10).text_color(on ? t.accent : t.muted)
      .cursor_pointer().hover((s) => s.border_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { click(); cx.notify(); })
      .child(label);
  }

  button(t, id, label, click) {
    return div().id(id).flex_none().px(8).h(22).flex().items_center().border(1).border_color(alpha(t.border, "a0"))
      .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover).border_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => click()).child(label);
  }

  frame(t, title, sub, body, foot) {
    return v_flex().id("chronicle-window").size_full().bg(alpha(t.popover, "")).text_color(t.foreground)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(h_flex().flex_none().h(34).px(10).gap(8).items_center().border_b(2).border_color(alpha(t.border, "60"))
        .bg(alpha(t.chrome, ""))
        .child(svg("mods/pixel-chrome/icons/quill.svg").size(14).text_color("#ffc25c"))
        .child(div().flex_none().text_color(t.accent).child(title))
        .child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.muted).child(sub))
        .child(div().id("cw-close").flex_none().p(3).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props().overlay))
          .child(svg("mods/pixel-chrome/icons/close.svg").size(13))))
      .child(body)
      .when(Boolean(foot), (el) => el.child(foot));
  }

  // Since you left: what happened while the person was away.
  report(t) {
    const r = props().report;
    const ev = [...(r.events ?? [])].reverse();
    const count = (f) => ev.filter(f).length;
    const quests = count((e) => e.kind === "done");
    const asks = count((e) => e.kind === "question");
    const helpNow = agents().filter((a) => a.status === "blocked");
    const trouble = count((e) => e.kind === "rage" || e.kind === "fail" || (e.kind === "tests" && !e.ok));
    const loot = count((e) => e.kind === "loot");
    const parts = [quests && `${quests} quest${quests > 1 ? "s" : ""} complete`, asks && `${asks} asked you something`,
      helpNow.length && `${helpNow.length} still need${helpNow.length > 1 ? "" : "s"} you`, trouble && `${trouble} took hits`,
      loot && `${loot} loot`].filter(Boolean);
    const body = v_flex().flex_1().min_h(0)
      .child(div().flex_none().px(12).py(8).text_size(13).text_color(t.foreground)
        .child(parts.length ? `While you were away: ${parts.join(" · ")}` : "While you were away, the party kept walking."))
      .child(v_flex().id("report-list").flex_1().min_h(0).overflow_y_scrollbar().pb(6).children(this.list(t, ev)));
    const foot = h_flex().flex_none().h(38).px(10).gap(8).items_center().border_t(2).border_color(alpha(t.border, "60"))
      .child(div().flex_1().font_family("Galmuri9").text_size(10).text_color(t.dim).child("Click a line to go there"))
      .when(helpNow.length > 0, (el) => el.child(this.button(t, "cw-help", `Answer HELP! (${helpNow.length})`, () => {
        closeOverlay(props().overlay);
        openOverlay({ mod: "pixel-help", kind: "dialog", width: 620, height: 470, frame: "none", props: {} });
      })))
      .child(this.button(t, "cw-log", "Journey log", () => {
        closeOverlay(props().overlay);
        openOverlay({ mod: "pixel-chronicle", kind: "window", key: "journey-log", width: 700, height: 560, props: {} });
      }))
      .child(this.button(t, "cw-ok", "Got it", () => closeOverlay(props().overlay)));
    return this.frame(t, "SINCE YOU LEFT", `${clock(r.since)} – ${clock(r.until)} · away ${span(r.until - r.since)}`, body, foot);
  }

  // The journey log: every space's events, newest first.
  log(t) {
    const shown = spaces().find((s) => s.active)?.name ?? null;
    const f = FILTERS.find((x) => x.id === this.filter) ?? FILTERS[0];
    const all = this.events ?? [];
    const ev = all.filter((e) => f.has(e) && (!this.here || !shown || e.space === shown));
    const bar = h_flex().flex_none().h(30).px(10).gap(5).items_center().border_b(1).border_color(alpha(t.border, "40"))
      .children(FILTERS.map((x) => this.chip(t, `f-${x.id}`, x.label, this.filter === x.id, () => { this.filter = x.id; })))
      .child(div().flex_1())
      .child(this.chip(t, "f-here", shown ? `Only ${shown}` : "Only this space", this.here, () => { this.here = !this.here; }))
      .child(this.chip(t, "f-reload", "Reload", false, () => { this.events = null; }));
    if (this.events === null) {
      // reloading: read the file again on the next draw
      this.events = [];
      this.pendingReload = true;
    }
    const body = v_flex().flex_1().min_h(0).child(bar)
      .child(v_flex().id("log-list").flex_1().min_h(0).overflow_y_scrollbar().pb(6)
        .children(ev.length ? this.list(t, ev)
          : [div().p(16).text_size(12).text_color(t.dim).child(all.length ? "Nothing of this kind yet." : "The journey has just begun: events appear here as the party works.")]));
    return this.frame(t, "JOURNEY LOG", `${all.length} events · every space`, body, null);
  }

  render(cx) {
    const t = theme();
    if (!props()?.overlay) return div();
    if (props().report) return this.report(t);
    if (this.pendingReload) {
      this.pendingReload = false;
      this.loadLog(cx);
    }
    return this.log(t);
  }
}
