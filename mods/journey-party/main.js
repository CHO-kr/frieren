// Journey party: draws each of agents() as a Frieren party member card.
// Portrait + status effect (working = magic circle, needs help = !, resting = z z, done = flower), resumed session title,
// account and model, HP (short limit left) and MP (weekly limit left).
// Reads: usage-gauge's usage.json, the session list caches (claude-list.json / codex-list.json),
// and pane-account/who.py for agents started by hand. Writes only shared("journey.party") (face picks).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, spaces, terminals, appHome, home, readTextFile, exec, run, setAgentOrder, theme, shared, setShared, layout } from "herdr";
import { ROSTER, character, cardPath, facePath, entriesFor, agentKey, settle, launched, modelName, cleanText, gauges } from "./lib.js";

const HOME = appHome();
const JOBS_FILE = `${HOME}/mods/journey-party/jobs.json`;
const WHO = `${HOME}/mods/pane-account/who.py`;
const DATA = () => `${home()}/AppData/Local/herdr-sessions`;
const STATUS = { working: "Working", blocked: "Needs help", done: "Done", idle: "Resting" };
const PW = 66;
const PH = 99;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const isAgent = (a) => /claude|codex/i.test(`${a.app ?? ""} ${a.program?.key ?? ""}`);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export default class JourneyParty extends View {
  init(_props, cx) {
    this.jobs = {};
    this.jobsLoaded = false;
    this.usage = null; // usage.json
    this.claude = []; // claude-list.json sessions
    this.codex = []; // codex-list.json threads
    this.who = {}; // terminal|app -> { at, account?, model?, error? }
    this.asking = new Set();
    this.lastShared = null;
    cx.spawn(async (cx) => {
      this.jobs = parse(await readTextFile(JOBS_FILE).catch(() => null)) ?? {};
      this.jobsLoaded = true;
      cx.notify();
    });
    this.load(cx);
    // Numbers only, so once a minute is enough. A fresh usage-gauge read changes shared and reloads this.
    cx.timer.every(60000, (cx) => this.load(cx));
    cx.timer.every(5000, (cx) => this.ask(cx));
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const [u, c, x] = await Promise.all([
        readTextFile(`${DATA()}/usage.json`).catch(() => null),
        readTextFile(`${DATA()}/claude-list.json`).catch(() => null),
        readTextFile(`${DATA()}/codex-list.json`).catch(() => null),
      ]);
      this.usage = parse(u) ?? this.usage;
      this.claude = parse(c)?.sessions ?? this.claude;
      this.codex = parse(x)?.threads ?? this.codex;
      cx.notify();
    });
  }

  // Agents typed into a shell ("claude2", "codex3") have no account in the command line: who.py reads the process.
  ask(cx) {
    const all = terminals();
    for (const a of agents()) {
      if (!isAgent(a) || a.address.includes("/")) continue;
      if (launched(all.find((k) => k.address === a.address)?.argv)) continue;
      const key = `${a.address}|${a.app ?? a.program?.key}`;
      const known = this.who[key];
      if ((known && Date.now() - known.at < 120000) || this.asking.has(key)) continue;
      this.asking.add(key);
      cx.spawn(async (cx) => {
        let found = { at: Date.now(), error: "lookup failed" };
        try {
          const r = await exec("python", ["-X", "utf8", WHO, a.address]);
          const out = parse(r.stdout || "{}") ?? {};
          found = out.account ? { at: Date.now(), account: out.account, model: out.model ?? null } : { at: Date.now(), error: out.error || "lookup failed" };
        } catch (e) {
          found.error = String(e?.message ?? e);
        }
        this.asking.delete(key);
        const changed = JSON.stringify({ ...found, at: 0 }) !== JSON.stringify({ ...(this.who[key] ?? {}), at: 0 });
        this.who[key] = found;
        if (changed) cx.notify();
      });
    }
  }

  // Which account, model and session one agent runs.
  facts(a) {
    const start = launched(terminals().find((k) => k.address === a.address)?.argv);
    const found = this.who[`${a.address}|${a.app ?? a.program?.key}`];
    const account = start?.account ?? found?.account ?? null;
    const codex = /codex/i.test(`${a.app ?? ""} ${account ?? ""}`);
    let session = null;
    if (start?.resume) {
      session = codex
        ? this.codex.find((s) => s.id === start.resume)
        : this.claude.find((s) => s.cli === start.resume || s.path === start.resume || s.id === start.resume);
    }
    const accountInfo = (shared(codex ? "sessions.codex" : "sessions.claude")?.accounts ?? []).find((x) => x.name === account);
    const model = start?.model ?? found?.model ?? session?.model ?? (!codex ? accountInfo?.model : null) ?? null;
    const usage = (this.usage?.accounts ?? []).find((x) => x.name === account) ?? null;
    return { account, codex, model: modelName(model), title: cleanText(session?.title, 60), usage, pending: !account && !found };
  }

  portrait(a, ch, t) {
    const st = a.status;
    const resting = st === "idle" || !st;
    return div()
      .relative()
      .w(PW)
      .h(PH)
      .flex_none()
      .border(1)
      .border_color(st === "blocked" ? t.blocked : `${ch.color}99`)
      .child(image(cardPath(ch)).w(PW - 2).h(PH - 2).when(resting, (el) => el.opacity(0.78)))
      .child(
        div().absolute().left(0).right(0).bottom(0).h(15).bg("#0a0f1ccc").flex().items_center().justify_center()
          .text_size(10).font_semibold().text_color(ch.color).child(ch.name),
      )
      .when(st === "working", (el) => el
        .child(svg("mods/journey-party/magic-circle.svg").absolute().right(2).bottom(17).size(24).text_color(t.working).spin(5000))
        .child(svg("mods/journey-party/sparkle.svg").absolute().left(4).top(5).size(10).text_color(ch.color).loop("opacity", { from: 0.1, to: 1, period: 1100 }))
        .child(svg("mods/journey-party/sparkle.svg").absolute().right(7).top(20).size(7).text_color("#f3efe2").loop("opacity", { from: 1, to: 0.05, period: 1500 })))
      .when(st === "blocked", (el) => el.child(
        div().absolute().right(3).top(3).size(17).rounded_full().bg(t.blocked).flex().items_center().justify_center()
          .text_size(12).font_semibold().text_color("#0b1120").child("!").loop("opacity", { from: 0.35, to: 1, period: 800 }),
      ))
      .when(st === "idle", (el) => el.child(div().absolute().right(4).top(2).text_size(10).font_semibold().text_color("#e8e2d0").frames(["z", "z z", "z z z", ""], 700)))
      .when(st === "done", (el) => el.child(div().absolute().right(4).top(1).text_size(13).text_color(t.done).child("✿").loop("opacity", { from: 0.4, to: 1, period: 1400 })));
  }

  bar(id, label, g, color, t) {
    return h_flex().id(id).w_full().min_w(0).h(13).gap(6).items_center().tooltip(g.tip)
      .child(div().w(18).flex_none().text_size(9.5).font_semibold().text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).h(5).bg(t.raised).when(g.pct != null, (el) => el.child(div().h_full().w(`${g.pct}%`).bg(color))))
      .child(div().w(30).flex_none().text_size(10.5).text_color(g.stale ? t.dim : t.foreground).child(g.text));
  }

  card(a, ch, now, t) {
    const f = this.facts(a);
    const frame = a.status === "blocked" ? t.blocked : a.focused ? t.accent : t.border;
    const statusColor = t[a.status] ?? t.dim;
    const tagColor = f.codex ? t.unknown : t.accent;
    const g = gauges(f.usage, now);
    const who = [f.account ?? (f.pending ? "checking account" : null), f.model].filter(Boolean).join(" · ");
    const sub = f.title ?? `${ch.name} · ${ch.role}`;
    return h_flex()
      .id(`party-${a.address}`)
      .w_full()
      .flex_none()
      .p(7)
      .gap(9)
      .items_center()
      .bg(a.focused ? t.raised : t.surface)
      .border(1)
      .border_color(frame)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(this.portrait(a, ch, t))
      .child(
        v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().w_full().min_w(0).gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(a.tab_name || a.address))
            .child(div().flex_none().text_size(10.5).text_color(statusColor).child(STATUS[a.status] ?? a.status ?? "")))
          .child(div().w_full().min_w(0).truncate().text_size(11).text_color(f.title ? t.muted : t.dim).child(sub))
          .when(isAgent(a), (el) => el.child(h_flex().w_full().min_w(0).h(16).gap(5).items_center()
            .child(div().flex_none().px(4).border(1).border_color(tagColor).text_size(9.5).text_color(tagColor).child(f.codex ? "Codex" : "Claude"))
            .when(Boolean(who), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(who)))))
          .when(isAgent(a), (el) => el
            .child(this.bar(`hp-${a.address}`, "HP", g.hp, t.accent, t))
            .child(this.bar(`mp-${a.address}`, "MP", g.mp, t.working, t))),
      );
  }

  // Folded sidebar: face and status dot only.
  compact(a, ch, t) {
    const color = t[a.status] ?? null;
    return div().id(`party-${a.address}`).relative().size(34).flex_none().border(1)
      .border_color(a.status === "blocked" ? t.blocked : a.focused ? t.accent : t.border)
      .cursor_pointer().on_click(() => run("agent.focus", { terminal: a.address }))
      .child(image(facePath(ch)).size(32))
      .when(Boolean(color) && a.status !== "idle", (el) => el.child(div().absolute().right(1).bottom(1).size(7).rounded_full().bg(color)));
  }

  render(cx) {
    const t = theme();
    const list = agents();
    const sp = spaces();
    setAgentOrder(list.map((a) => a.address));
    const stored = shared("journey.party") ?? {};
    const picks = settle(stored, entriesFor(sp, list), this.jobs);
    if (this.jobsLoaded && JSON.stringify(picks) !== JSON.stringify(stored)) setShared("journey.party", picks);
    // A fresh usage-gauge read means a fresh usage.json.
    const brief = JSON.stringify(shared("usage.accounts") ?? null);
    if (this.lastShared !== null && brief !== this.lastShared) this.load(cx);
    this.lastShared = brief;
    const now = Date.now();
    const chOf = (a) => character(picks[agentKey(a, list)]) ?? ROSTER[0];
    if (narrow()) {
      return v_flex().id("journey-party").size_full().min_h(0).items_center().gap(5).py(6).overflow_y_scrollbar()
        .children(list.map((a) => this.compact(a, chOf(a), t)));
    }
    const working = list.filter((a) => a.status === "working").length;
    return v_flex()
      .id("journey-party")
      .size_full()
      .min_h(0)
      .text_color(t.foreground)
      .text_size(13)
      .child(h_flex().h(31).flex_none().pl(16).pr(12).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().child("Party"))
        .child(div().text_color(t.muted).child(`${list.length} ${list.length === 1 ? "member" : "members"}`))
        .child(div().flex_1())
        .when(working > 0, (el) => el.child(div().text_color(t.working).child(`${working} working`))))
      .child(
        v_flex().flex_1().min_h(0).gap(6).px(6).pb(8).overflow_y_scrollbar()
          .children(list.map((a) => this.card(a, chOf(a), now, t)))
          .when(list.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("No party members yet. Start an agent in a tab and it joins."))),
      );
  }
}
