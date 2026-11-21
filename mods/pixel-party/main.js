// Pixel party: each of agents() as a Frieren party member, drawn as an animated pixel sprite.
// The sprite acts out what the agent is doing (status from Herdr, the current tool read from the agent's screen):
// casting a spell for commands, reading a grimoire for reads and searches, writing runes for edits, flying for the web,
// summoning for sub-agents, "!" when it needs you, a flower field when done, asleep when idle.
// This mod is also the one that reads the screens: it shares what it finds as shared("pixel.activity") for pixel-pane.
// Reads: usage-gauge's usage.json, the session list caches, pane-account/who.py for agents started by hand.
// Writes only shared("journey.party") (character picks, the same as the journey layout's) and shared("pixel.activity").
// An agent that reports no status to Herdr (a Claude Code background job: its pane says claude, agents() lacks it) is
// listed too, its status read from its screen (shared in pixel.activity as `status`).
// Members who need you, work, are done or asked you something get a full card, on top; the others a one-line row.
// pixel-chronicle's shared("pixel.deeds") adds, per member: MEM (how much of its conversation's context is left; INN
// sends /compact while it rests), "Asks you" when its last turn ended with a question, and its latest outcome (a hit
// for a failed command, CLEAR / WOUNDED for a test run, RAGE after 3 failures in a row).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, terminals, appHome, home, readTextFile, exec, hc, run, setAgentOrder, theme, shared, setShared, layout, checking, openOverlay } from "herdr";
import { ROSTER, character, facePath, familyOf, frames, battleLine, classify, screenStatus, isAgentPane, entriesFor, agentKey, settle, launched, modelName, cleanText, gauges, ART, alpha, backdrop, ACTING } from "./lib.js";

const HOME = appHome();
const JOBS_FILE = `${HOME}/mods/journey-party/jobs.json`;
const WHO = `${HOME}/mods/pane-account/who.py`;
const DATA = () => `${home()}/AppData/Local/herdr-sessions`;
const STATUS = { working: "Acting", blocked: "Needs help", done: "Done", idle: "Resting", asks: "Asks you" };
const ORDER = { blocked: 0, asks: 1, working: 1, done: 2 };
const ASK = "#ffd35a"; // a question waits for the person
const MEM = "#c49bff";
const kTok = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
const deedsOf = (address) => shared("pixel.deeds")?.terminals?.[address] ?? null;
// An agent at rest whose last turn ended with a question: it waits for an answer, not done.
const asks = (a, d) => Boolean(d?.question) && (a.status === "done" || a.status === "idle");
// What's left of its context, as a gauge like HP and MP.
function memGauge(c) {
  if (!c) return { pct: null, text: "—", tip: "MEM (context): not read yet" };
  const left = Math.max(0, 100 - c.pct);
  return { pct: left, text: `${left}%`, tip: `MEM (context): ${kTok(c.used)} of ${kTok(c.full)} used · ${left}% left\nAt ${kTok(c.full)} the conversation is summarized and its details are forgotten.` };
}
// The latest outcome worth a chip: [label, color, tip] or null.
function outcomeChip(d, t, now) {
  if (!d) return null;
  if (d.streak >= 3 && d.hit) return [`RAGE ×${d.streak}`, t.blocked, `${d.streak} failures in a row. Latest: ${d.hit.detail}`];
  const tests = d.tests;
  if (tests && now - tests.at < 10 * 60000) {
    const n = tests.passed != null || tests.failed ? ` (${tests.passed ?? 0} passed${tests.failed ? `, ${tests.failed} failed` : ""})` : "";
    if (!tests.ok) return ["WOUNDED", t.blocked, `The check failed${n}\n${tests.detail}`];
    if (!d.hit || d.hit.at < tests.at) return ["CLEAR", t.done, `ALL CLEAR: the check passed${n}\n${tests.detail}`];
  }
  if (d.hit && now - d.hit.at < 3 * 60000) return [d.wounds > 1 ? `HIT ×${d.wounds}` : "HIT", t.blocked, `${d.hit.what === "edit" ? "An edit failed" : "A command failed"}: ${d.hit.detail}`];
  return null;
}

// Agent panes agents() doesn't list, shaped like agents() rows
function unreported() {
  const known = new Set(agents().map((a) => a.address));
  const where = new Map(spaces().flatMap((s) => (s.tabs ?? []).map((t) => [t.id, { t, s }])));
  return panes().filter((q) => q.terminal && isAgentPane(q) && !known.has(q.terminal)).map((q) => {
    const at = where.get(q.tab);
    return { address: q.terminal, pane: q.pane, space: at?.s.id ?? null, space_name: at?.s.name ?? "", tab: q.tab, tab_index: at?.t.index ?? 0,
      tab_name: at?.t.name ?? "", status: null, app: q.app, program: q.program, title: q.title, seq: 0, pinned: false, focused: q.focused, unreported: true };
  });
}
const SOLO_W = ART.solo * ART.scale;
const SPR_H = ART.height * ART.scale;

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

// One animated sprite: a glyph of the character's color pixel font, switched natively by .frames().
export function sprite(ch, anim, solo, key) {
  const f = frames(anim, solo);
  return div().id(key).flex_none().h(SPR_H).w((solo ? ART.solo : ART.stage) * ART.scale).overflow_hidden()
    .font_family(familyOf(ch)).text_size(SPR_H).line_height(1).whitespace_nowrap()
    .frames(f.list, f.ms);
}

export default class PixelParty extends View {
  init(_props, cx) {
    this.jobs = {};
    this.jobsLoaded = false;
    this.usage = null;
    this.claude = [];
    this.codex = [];
    this.who = {};
    this.asking = new Set();
    this.lastShared = null;
    this.activity = {}; // address -> { kind, detail }
    this.reading = false;
    cx.spawn(async (cx) => {
      this.jobs = parse(await readTextFile(JOBS_FILE).catch(() => null)) ?? {};
      this.jobsLoaded = true;
      cx.notify();
    });
    this.load(cx);
    cx.timer.every(60000, (cx) => this.load(cx));
    cx.timer.every(5000, (cx) => this.ask(cx));
    // outcome chips (HIT, CLEAR) fade after a few minutes even when nothing else redraws the party
    cx.timer.every(30000, (cx) => { if (shared("pixel.deeds")) cx.notify(); });
    this.resting = new Set(); // terminals sent /compact: the INN button waits until it's done
    if (checking()) return;
    // What each working agent is doing: its screen, read every 1.5 s while it works.
    cx.timer.every(1500, (cx) => this.watch(cx));
  }

  watch(cx) {
    if (this.reading) return;
    const busy = agents().filter((a) => a.status === "working");
    const quiet = unreported();
    const known = Object.keys(this.activity);
    if (!busy.length && !quiet.length && !known.length) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const next = {};
      await Promise.all(busy.map(async (a) => {
        try {
          const r = await hc(["read", a.address]);
          if (r.code === 0) next[a.address] = classify(r.stdout);
        } catch {}
        next[a.address] ??= this.activity[a.address] ?? { kind: "think", detail: null };
      }));
      await Promise.all(quiet.map(async (a) => {
        try {
          const r = await hc(["read", a.address]);
          if (r.code !== 0) return;
          const status = screenStatus(r.stdout);
          next[a.address] = { ...(status === "working" ? classify(r.stdout) : { kind: "think", detail: null }), status };
        } catch {}
      }));
      this.reading = false;
      if (JSON.stringify(next) !== JSON.stringify(this.activity)) {
        this.activity = next;
        setShared("pixel.activity", next);
      }
    });
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

  // A JRPG gauge: 10 blocks, lit by what's left. extra: an element at its end (MEM's INN button).
  bar(id, label, g, color, t, extra = null) {
    const lit = g.pct == null ? 0 : Math.round(g.pct / 10);
    const low = g.pct != null && g.pct <= 20;
    return h_flex().id(id).w_full().min_w(0).h(12).gap(5).items_center().tooltip(g.tip)
      .child(div().w(22).flex_none().font_family("Galmuri9").text_size(10).text_color(color).child(label))
      .child(h_flex().flex_none().gap(1).children(Array.from({ length: 10 }, (_, i) =>
        div().w(6).h(6).bg(i < lit ? (low ? t.blocked : color) : `${t.raised}`).when(i < lit, (el) => el.border_t(1).border_color("#ffffff40")))))
      .child(div().flex_1().min_w(0).font_family("Galmuri9").text_size(10).text_color(g.stale ? t.dim : t.foreground).child(g.text))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // INN: a member at rest with little context left can rest at the inn: /compact summarizes its conversation.
  // Typed key by key (hc send would wrap it as a message), only while it rests (not working, not asking for help).
  inn(a, d, t) {
    const c = d?.context;
    if (!c || c.pct < 50 || (a.status !== "idle" && a.status !== "done") || !d.kind) return null;
    const busy = this.resting.has(a.address);
    return div().id(`inn-${a.address}`).flex_none().px(3).h(11).flex().items_center().border(1)
      .border_color(busy ? alpha(t.border, "60") : MEM).font_family("Galmuri9").text_size(9).text_color(busy ? t.dim : MEM)
      .cursor_pointer().hover((s) => s.bg(alpha(MEM, "24")))
      .tooltip(busy ? "Resting at the inn… (/compact sent)"
        : `Rest at the inn: types /compact into this ${d.kind === "codex" ? "Codex" : "Claude"} session, which summarizes the conversation and frees its memory (${100 - c.pct}% left).`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (busy) return;
        const now = agents().find((x) => x.address === a.address);
        if (now && now.status !== "idle" && now.status !== "done") return;
        this.resting.add(a.address);
        cx.spawn(async (cx) => {
          try {
            await hc(["keys", a.address, "--", ..."/compact".split("")]);
            await hc(["keys", a.address, "enter"]);
          } catch {}
          cx.notify();
        });
        cx.timer.after(120000, (cx) => { this.resting.delete(a.address); cx.notify(); });
        cx.notify();
      })
      .child("INN");
  }

  card(a, ch, now, t, act) {
    const f = this.facts(a);
    const d = deedsOf(a.address);
    const q = asks(a, d);
    const frame = a.status === "blocked" ? t.blocked : q ? ASK : a.focused ? t.accent : alpha(t.border, "80");
    const statusColor = q ? ASK : t[a.status] ?? t.dim;
    const tagColor = f.codex ? t.unknown : t.accent;
    const g = gauges(f.usage, now);
    const who = [f.account ?? (f.pending ? "checking account" : null), f.model].filter(Boolean).join(" · ");
    const line = battleLine(ch, a.status, act);
    const statusText = a.status === "working" ? (ACTING[line.anim] ?? STATUS.working) : q ? STATUS.asks : (STATUS[a.status] ?? a.status ?? "");
    const out = outcomeChip(d, t, now);
    const tip = `${ch.name} · ${ch.role}\n${q ? `Asks you: ${d.question.text}` : line.detail ? `${line.text}  ${line.detail}` : line.text}`;
    // Two lines over the gauges, so a card is as tall as its 64 px stage.
    return h_flex()
      .id(`party-${a.address}`)
      .w_full()
      .flex_none()
      .p(4)
      .gap(7)
      .items_center()
      .tooltip(tip)
      .bg(a.focused ? alpha(t.accent, "14") : alpha(t.background, "4d"))
      .border(2)
      .border_color(frame)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.go(a))
      .child(
        // the battle tile: a strip of ground under the sprite; "?" over it while a question waits
        div().relative().flex_none().w(SOLO_W).h(SPR_H).border(0)
          .child(image(backdrop(shared("pixel.scene"), true)).absolute().left(0).top(0).w(SOLO_W).h(SPR_H).when(a.status === "idle" && !q, (el) => el.opacity(0.7)))
          .child(div().absolute().left(0).top(0).child(sprite(ch, line.anim, true, `spr-${a.address}`)))
          .when(q, (el) => el.child(div().id(`ask-${a.address}`).absolute().right(2).top(0).text_size(16).font_semibold().text_color(ASK)
            .loop("opacity", { from: 0.35, to: 1, period: 1100 }).child("?"))),
      )
      .child(
        v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().w_full().min_w(0).gap(6).items_center()
            .when(a.focused, (el) => el.child(svg("mods/pixel-chrome/icons/cursor.svg").size(10).flex_none().text_color(t.accent)))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.tab_name || a.address))
            .when(Boolean(out), (el) => el.child(div().id(`out-${a.address}`).flex_none().px(3).border(1).border_color(out[1])
              .font_family("Galmuri9").text_size(9).text_color(out[1]).tooltip(out[2]).child(out[0])))
            .child(a.status === "blocked"
              // a call for help is answered right here (pixel-help) without going to its space
              ? div().id(`help-${a.address}`).flex_none().px(3).border(1).border_color(t.blocked).font_family("Galmuri9").text_size(10)
                .text_color(t.blocked).cursor_pointer().hover((s) => s.bg(alpha(t.blocked, "30"))).tooltip("Answer it here (HELP!, Ctrl+Shift+H)")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  openOverlay({ mod: "pixel-help", kind: "dialog", width: 620, height: 470, frame: "none", props: { terminal: a.address } });
                })
                .child("HELP!")
              : div().flex_none().font_family("Galmuri9").text_size(10).text_color(a.status === "working" ? t.working : statusColor).child(statusText)))
          .child(h_flex().w_full().min_w(0).gap(5).items_center().font_family("Galmuri9").text_size(10)
            .child(div().flex_none().text_color(ch.color).child(ch.name))
            .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(who || (isAgent(a) ? "" : line.text)))
            .when(isAgent(a), (el) => el.child(div().flex_none().px(3).border(1).border_color(tagColor).text_color(tagColor).child(f.codex ? "Codex" : "Claude"))))
          .when(isAgent(a), (el) => el
            .child(this.bar(`hp-${a.address}`, "HP", g.hp, "#7fe0b8", t))
            .child(this.bar(`mp-${a.address}`, "MP", g.mp, "#86b4ff", t))
            .when(Boolean(d?.context), (el) => el.child(this.bar(`mem-${a.address}`, "MEM", memGauge(d.context), MEM, t, this.inn(a, d, t))))),
      );
  }

  go(a) {
    if (a.unreported) run("pane.focus", { pane: a.pane });
    else run("agent.focus", { terminal: a.address });
  }

  // A member who rests (or a shell): one line, its face, tab, character, status and what's left of its usage.
  row(a, ch, now, t) {
    const f = this.facts(a);
    const g = gauges(f.usage, now);
    const d = deedsOf(a.address);
    const m = d?.context ? memGauge(d.context) : null;
    const tip = `${ch.name} · ${ch.role}\n${[f.account, f.model].filter(Boolean).join(" · ") || battleLine(ch, a.status, null).text}${g.hp?.tip ? `\n${g.hp.tip}` : ""}${m ? `\n${m.tip}` : ""}`;
    return h_flex()
      .id(`party-${a.address}`)
      .w_full()
      .flex_none()
      .h(24)
      .px(4)
      .gap(6)
      .items_center()
      .tooltip(tip)
      .bg(a.focused ? alpha(t.accent, "14") : alpha(t.background, "33"))
      .border(1)
      .border_color(a.focused ? t.accent : alpha(t.border, "50"))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.go(a))
      .child(image(facePath(ch)).size(18).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(a.status === "idle" ? t.muted : t.foreground).child(a.tab_name || a.address))
      .child(div().flex_none().font_family("Galmuri9").text_size(10).text_color(ch.color).child(ch.name))
      .when(g.hp?.pct != null, (el) => el.child(div().flex_none().font_family("Galmuri9").text_size(10)
        .text_color(g.hp.pct <= 20 ? t.blocked : t.dim).child(`HP ${g.hp.pct}%`)))
      .when(m?.pct != null && m.pct <= 50, (el) => el.child(div().flex_none().font_family("Galmuri9").text_size(10)
        .text_color(m.pct <= 20 ? t.blocked : MEM).child(`MEM ${m.pct}%`)))
      .when(Boolean(this.inn(a, d, t)), (el) => el.child(this.inn(a, d, t)))
      .child(div().flex_none().font_family("Galmuri9").text_size(10).text_color(t.dim).child(STATUS[a.status] ?? "Shell"));
  }

  // Folded sidebar: face and a status pip.
  compact(a, ch, t) {
    const color = asks(a, deedsOf(a.address)) ? ASK : t[a.status] ?? null;
    return div().id(`party-${a.address}`).relative().size(36).flex_none().border(2)
      .border_color(a.status === "blocked" ? t.blocked : a.focused ? t.accent : alpha(t.border, "80"))
      .cursor_pointer().on_click(() => this.go(a))
      .child(image(facePath(ch)).size(32))
      .when(Boolean(color) && a.status !== "idle", (el) => el.child(div().absolute().right(0).bottom(0).size(8).bg(color).border(1).border_color(alpha(t.background, ""))));
  }

  render(cx) {
    const t = theme();
    const sp = spaces();
    const reported = agents();
    // in screen order (space, tab), the unreported ones with the status their screen shows
    const spaceAt = new Map(sp.map((s, i) => [s.id, i]));
    const list = [...reported, ...unreported().map((a) => ({ ...a, status: this.activity[a.address]?.status ?? shared("pixel.activity")?.[a.address]?.status ?? "idle" }))]
      .map((a, i) => [a, i]).sort(([a, i], [b, j]) => (spaceAt.get(a.space) ?? 0) - (spaceAt.get(b.space) ?? 0) || a.tab_index - b.tab_index || i - j).map(([a]) => a);
    setAgentOrder(reported.map((a) => a.address));
    const stored = shared("journey.party") ?? {};
    const picks = settle(stored, entriesFor(sp, list), this.jobs);
    if (this.jobsLoaded && JSON.stringify(picks) !== JSON.stringify(stored)) setShared("journey.party", picks);
    const brief = JSON.stringify(shared("usage.accounts") ?? null);
    if (this.lastShared !== null && brief !== this.lastShared) this.load(cx);
    this.lastShared = brief;
    const now = Date.now();
    const chOf = (a) => character(picks[agentKey(a, list)]) ?? ROSTER[0];
    if (narrow()) {
      return v_flex().id("pixel-party").size_full().min_h(0).items_center().gap(5).py(6).overflow_y_scrollbar()
        .children(list.map((a) => this.compact(a, chOf(a), t)));
    }
    const working = list.filter((a) => a.status === "working").length;
    const blocked = list.filter((a) => a.status === "blocked").length;
    const asking = list.filter((a) => asks(a, deedsOf(a.address))).length;
    // a member asking you something sorts and shows like one that needs you
    const rank = (a) => (asks(a, deedsOf(a.address)) ? "asks" : a.status);
    return v_flex()
      .id("pixel-party")
      .size_full()
      .min_h(0)
      .text_color(t.foreground)
      .text_size(12)
      .child(h_flex().h(28).flex_none().pl(10).pr(10).gap(6).items_center().border_b(2).border_color(alpha(t.border, "60"))
        .child(svg("mods/pixel-chrome/icons/heart.svg").size(12).text_color("#ff7a8a"))
        .child(div().text_color(t.accent).child("PARTY"))
        .child(div().font_family("Galmuri9").text_size(10).text_color(t.muted).child(`${list.length} ${list.length === 1 ? "member" : "members"}`))
        .child(div().flex_1())
        .when(blocked > 0, (el) => el.child(div().font_family("Galmuri9").text_size(10).text_color(t.blocked).child(`${blocked} need help`)))
        .when(asking > 0, (el) => el.child(div().font_family("Galmuri9").text_size(10).text_color(ASK).child(`${asking} ask${asking > 1 ? "" : "s"}`)))
        .when(working > 0, (el) => el.child(div().font_family("Galmuri9").text_size(10).text_color(t.working).child(`${working} acting`)))
        .child(div().id("party-log").flex_none().p(2).text_color(t.dim).cursor_pointer().hover((s) => s.text_color("#ffc25c"))
          .tooltip("Journey log: every space's quests, calls for help, hits and loot (Ctrl+Shift+J)")
          .on_click(() => openOverlay({ mod: "pixel-chronicle", kind: "window", key: "journey-log", width: 700, height: 560, props: {} }))
          .child(svg("mods/pixel-chrome/icons/quill.svg").size(12))))
      .child(
        v_flex().flex_1().min_h(0).gap(4).p(6).overflow_y_scrollbar()
          .children(list.map((a, i) => [a, i]).sort(([a, i], [b, j]) => (ORDER[rank(a)] ?? 3) - (ORDER[rank(b)] ?? 3) || i - j)
            .map(([a]) => (rank(a) in ORDER
              ? this.card(a, chOf(a), now, t, this.activity[a.address] ?? shared("pixel.activity")?.[a.address])
              : this.row(a, chOf(a), now, t))))
          .when(list.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("No companions yet. Start an agent in a tab and it joins the party."))),
      );
  }
}
