// Pixel help: HELP! answered in place. A party member who needs the operator (an agent "blocked" on a permission or a
// choice question) speaks in an RPG dialogue box over whatever is on screen, and the operator picks the answer there.
//   mod.open:pixel-help (ctrl-shift-h): every blocked agent in every space, the one waiting longest first.
//   openOverlay({ mod: "pixel-help", kind: "dialog", width: 620, height: 470, frame: "none", props: { terminal } }):
//     that terminal first (any terminal, blocked or not), then the other blocked agents.
// It reads the screen with `hc read` (prompt.js finds the question and its numbered options), and when the operator
// picks one (1-9, ↑↓ + Enter, a click) it reads the screen again and sends the key with `hc keys` only if the same
// question is still there: the digit (Claude Code picks at once), or Codex's letter when the option shows one ("(y)").
// If the question still sits there afterwards (a form that submits on Enter), it moves the highlight onto the pick
// with arrows if needed and sends Enter only after reading the screen again and seeing that question with the pick
// highlighted. Options that need typing ("No, and tell Claude what to do differently"), multi-select questions and a
// terminal sitting on a text box go to the terminal instead. Nothing is sent without the operator's pick.
import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, hc, run, theme, shared, props, closeOverlay, checking } from "herdr";
import { ROSTER, character, facePath, isAgentPane, agentKey, alpha, mix } from "./party.js";
import { readPrompt, sameAsk, askKey, keyFor, tailLines, cut } from "./prompt.js";

const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const READ_MS = 1500; // the shown member's screen is read again this often while the dialog is open
const AFTER_MS = [1000, 800, 800, 1000, 1200, 1500]; // after a key is sent: when to look whether it took
const BODY_LINES = 4;
const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();

// Agent panes agents() doesn't list (a Claude Code background job), shaped like agents() rows, as pixel-party does
function unreported() {
  const known = new Set(agents().map((a) => a.address));
  const where = new Map(spaces().flatMap((s) => (s.tabs ?? []).map((t) => [t.id, { t, s }])));
  return panes().filter((q) => q.terminal && isAgentPane(q) && !known.has(q.terminal)).map((q) => {
    const at = where.get(q.tab);
    return { address: q.terminal, pane: q.pane, space: at?.s.id ?? null, space_name: at?.s.name ?? "", tab: q.tab, tab_index: at?.t.index ?? 0,
      tab_name: at?.t.name ?? "", status: null, app: q.app, program: q.program, title: q.title, seq: 0, unreported: true };
  });
}
// The party in screen order (space, tab), the same list pixel-party picks characters from
function partyList() {
  const spaceAt = new Map(spaces().map((s, i) => [s.id, i]));
  return [...agents(), ...unreported()].map((a, i) => [a, i])
    .sort(([a, i], [b, j]) => (spaceAt.get(a.space) ?? 0) - (spaceAt.get(b.space) ?? 0) || a.tab_index - b.tab_index || i - j)
    .map(([a]) => a);
}

export default class PixelHelp extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.pinned = props()?.terminal ?? null; // the terminal a caller asked for
    // a pinned agent that was blocked and gets answered in its terminal meanwhile is dropped, like the others
    this.pinnedBlocked = agents().some((a) => a.address === this.pinned && a.status === "blocked");
    this.current = this.pinned ?? this.queue()[0] ?? null;
    this.reads = {}; // address -> { text, ask, tail, error, key }
    this.sel = null; // the highlighted option
    this.note = null; // { text, tone }
    this.busy = null; // "checking" (reading again before sending) | "waiting" (sent, watching whether it took)
    this.reading = false;
    this.answered = new Map(); // address -> { seq, at }: answered, so skipped until its status moves on
    if (checking()) return;
    cx.timer.after(250, () => this.handle.focus());
    if (this.current) this.read(cx, this.current);
    cx.timer.every(READ_MS, (cx) => this.tick(cx));
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Who waits: the pinned terminal, then blocked agents oldest first (lowest seq = changed longest ago), then agent
  // panes agents() doesn't list whose screen pixel-party read as a question.
  queue() {
    const recent = (addr, seq) => {
      const done = this.answered?.get(addr);
      return Boolean(done) && (seq == null ? Date.now() - done.at < 8000 : done.seq === seq);
    };
    const blocked = agents().filter((a) => a.status === "blocked" && !recent(a.address, a.seq)).sort((a, b) => a.seq - b.seq).map((a) => a.address);
    const acts = shared("pixel.activity") ?? {};
    const quiet = unreported().filter((a) => acts[a.address]?.status === "blocked" && !recent(a.address, null)).map((a) => a.address);
    const list = [...blocked, ...quiet];
    return this.pinned ? [this.pinned, ...list.filter((x) => x !== this.pinned)] : list;
  }

  // The shown member, its character and where it is
  who(address) {
    const list = partyList();
    const a = list.find((x) => x.address === address) ?? null;
    const pane = panes().find((q) => q.terminal === address) ?? null;
    const tabId = a?.tab ?? pane?.tab ?? null;
    const space = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === tabId)) ?? null;
    const tab = space?.tabs.find((t) => t.id === tabId) ?? null;
    const picks = shared("journey.party") ?? {};
    const key = a ? agentKey(a, list) : tabId ? `tab:${tabId}` : null;
    const ch = character(picks[key]) ?? ROSTER[0];
    const app = a?.app ?? pane?.app ?? null;
    const program = a?.program?.name ?? pane?.program?.name ?? null;
    return { a, pane, ch, space: a?.space_name || space?.name || "", tab: a?.tab_name || tab?.name || "", app, program, agent: Boolean(a && !a.unreported) };
  }

  async screen(address) {
    try {
      const r = await hc(["read", address, "--lines", "40"]);
      return r.code === 0 ? { text: r.stdout } : { error: (r.stderr || r.stdout).trim() || "Can't read this terminal." };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  // Keeps a reading; a new question puts the highlight where the terminal has it
  store(address, got) {
    const before = this.reads[address];
    const ask = got.text != null ? readPrompt(got.text) : null;
    const entry = { text: got.text ?? null, error: got.error ?? null, ask, tail: got.text != null ? tailLines(got.text, 12) : [], key: askKey(ask) };
    this.reads[address] = entry;
    if (address === this.current && entry.key !== before?.key) {
      this.sel = ask?.selected ?? 0;
      // a warning about the last question doesn't fit the new one
      if (ask && this.note?.tone === "warn") this.note = { text: "The question changed — read it again", tone: "warn" };
    }
    return !before || before.text !== entry.text || before.error !== entry.error;
  }

  read(cx, address) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const got = await this.screen(address);
      this.reading = false;
      if (this.store(address, got)) cx.notify();
    });
  }

  tick(cx) {
    if (this.busy) return;
    if (this.pinned && this.pinnedBlocked && !agents().some((a) => a.address === this.pinned && a.status === "blocked")) this.pinned = null;
    const q = this.queue();
    if (!this.current || !q.includes(this.current)) {
      const next = q[0] ?? null;
      if (next !== this.current) {
        this.current = next;
        this.sel = this.reads[next]?.ask?.selected ?? 0;
        this.note = null;
        cx.notify();
      }
    }
    if (this.current) this.read(cx, this.current);
  }

  step(by, cx) {
    const q = this.queue();
    if (q.length < 2 || this.busy) return;
    const at = Math.max(0, q.indexOf(this.current));
    this.current = q[(at + by + q.length) % q.length];
    this.sel = this.reads[this.current]?.ask?.selected ?? 0;
    this.note = null;
    this.read(cx, this.current);
    cx.notify();
  }

  goTo(address) {
    const w = this.who(address);
    if (w.agent) run("agent.focus", { terminal: address });
    else if (w.pane) run("pane.focus", { pane: w.pane.pane });
    this.close();
  }

  // The operator picked option i: read again, send its key only if the same question is still there, then watch.
  choose(i, cx) {
    const address = this.current;
    const ask = this.reads[address]?.ask;
    const o = ask?.options[i];
    if (!o || this.busy) return;
    this.sel = i;
    const codex = /codex/i.test(this.who(address).app ?? "") || ask.marker === "›";
    if (!ask.answerable || o.free || !keyFor(o, codex)) return this.goTo(address);
    this.busy = "checking";
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const got = await this.screen(address);
      const now = got.text != null ? readPrompt(got.text) : null;
      if (!sameAsk(now, ask)) {
        this.store(address, got);
        this.busy = null;
        this.note = { text: now ? "The question changed — read it again" : "The question is gone — read the screen again", tone: "warn" };
        cx.notify();
        return;
      }
      const key = keyFor(now.options[i], codex);
      const label = now.options[i].label;
      const failed = await this.send(address, [key]);
      if (failed) {
        this.busy = null;
        this.note = { text: `Couldn't send the answer: ${cut(failed, 60)}`, tone: "warn" };
        cx.notify();
        return;
      }
      const seq = agents().find((a) => a.address === address)?.seq ?? null;
      this.answered.set(address, { seq, at: Date.now() });
      this.busy = "waiting";
      this.note = { text: `Sent “${key}” · ${label}`, tone: "info" };
      cx.notify();
      let nudged = false;
      let entered = false;
      for (const [n, ms] of AFTER_MS.entries()) {
        await cx.sleep(ms);
        const again = await this.screen(address);
        this.store(address, again);
        const next = this.reads[address].ask;
        const a = agents().find((x) => x.address === address);
        const stillBlocked = a ? a.status === "blocked" : null;
        // another question from the same member (the next of several, a new permission): show it
        if (next && !sameAsk(next, ask) && stillBlocked !== false) {
          this.answered.delete(address);
          this.busy = null;
          this.note = { text: "Next question", tone: "info" };
          cx.notify();
          return;
        }
        if (!next || stillBlocked === false) {
          this.busy = null;
          this.advance(cx, address);
          return;
        }
        // The same question is still there after a while: the key only moved the highlight (a form that submits on
        // Enter, "enter to submit"), or did nothing. Put the highlight on the pick with arrows if it isn't there, and
        // confirm with Enter only once the screen, read again just before, shows this question with the pick
        // highlighted.
        if (n >= 1 && next.answerable && next.selected != null) {
          if (next.selected !== i && !nudged) {
            nudged = true;
            const d = i - next.selected;
            await this.send(address, Array(Math.abs(d)).fill(d > 0 ? "down" : "up"));
          } else if (next.selected === i && !entered) {
            const check = await this.screen(address);
            const sure = check.text != null ? readPrompt(check.text) : null;
            if (sure && sameAsk(sure, ask) && sure.answerable && sure.selected === i) {
              entered = true;
              await this.send(address, ["enter"]);
              this.note = { text: `Sent “${key}”, then Enter · ${label}`, tone: "info" };
            }
          }
        }
        cx.notify();
      }
      this.answered.delete(address);
      this.busy = null;
      this.note = { text: "No change yet — it may not have taken the answer", tone: "warn" };
      cx.notify();
    });
  }

  // Presses keys in a terminal; the error text, or null when they went
  async send(address, keys) {
    if (!keys.length) return null;
    try {
      const r = await hc(["keys", address, ...keys]);
      return r.code === 0 ? null : (r.stderr || r.stdout || "").trim() || "hc keys failed";
    } catch (e) {
      return String(e?.message ?? e);
    }
  }

  // That member is answered: the next one who waits, or close when nobody is left.
  advance(cx, done) {
    if (this.pinned === done) this.pinned = null;
    const q = this.queue().filter((x) => x !== done);
    if (!q.length) return this.close();
    this.current = q[0];
    this.sel = this.reads[this.current]?.ask?.selected ?? 0;
    this.note = { text: "Answered · next one", tone: "info" };
    this.read(cx, this.current);
    cx.notify();
  }

  onKey(e, cx) {
    if (!this.press(e.key, e.modifiers ?? {}, cx)) return;
    cx.stop_propagation();
    cx.notify();
  }

  // One key: true when the dialog used it
  press(k, m, cx) {
    if (m.control || m.alt || m.platform) return false;
    const ask = this.reads[this.current]?.ask;
    const count = ask?.options.length ?? 0;
    if (k === "escape") this.close();
    else if (/^[1-9]$/.test(k) && !m.shift) {
      const i = ask?.options.findIndex((o) => o.n === Number(k)) ?? -1;
      if (i >= 0) this.choose(i, cx);
    } else if (k === "down" && count) { this.sel = ((this.sel ?? -1) + 1) % count; this.note = null; }
    else if (k === "up" && count) { this.sel = ((this.sel ?? 0) - 1 + count) % count; this.note = null; }
    else if (k === "enter") {
      if (ask && this.sel != null) this.choose(this.sel, cx);
      else if (this.current) this.goTo(this.current);
    } else if (k === "tab") this.step(m.shift ? -1 : 1, cx);
    else if (k === "right") this.step(1, cx);
    else if (k === "left") this.step(-1, cx);
    else return false;
    return true;
  }

  // ---------------------------------------------------------------- drawing
  window(t, el) {
    // an RPG window: a deep gradient, a light double edge, square corners
    const edge = mix(t.foreground, "#ffffff", 0.45);
    return el.relative().bg(t.popover).border(2).border_color(edge)
      .child(globalThis.window.paint_path(RECT(), Background.linear_gradient(180, mix(t.popover, t.accent, 0.1), mix(t.popover, "#000000", 0.35)))
        .absolute().top(0).left(0).size_full())
      .child(div().absolute().top(2).left(2).right(2).bottom(2).border(1).border_color(alpha(edge, "40")));
  }

  button(t, id, label, icon, onClick, strong) {
    return h_flex().id(id).h(26).px(10).gap(6).items_center().flex_none().cursor_pointer()
      .border(2).border_color(strong ? t.accent : alpha(t.foreground, "70")).bg(strong ? alpha(t.accent, "22") : alpha(t.background, "80"))
      .text_size(12).text_color(strong ? t.accent : t.foreground)
      .hover((s) => s.bg(alpha(t.accent, "33")).text_color(t.accent))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(11)))
      .child(label);
  }

  small(t, text, color) {
    return div().flex_none().px(4).h(14).flex().items_center().border(1).border_color(alpha(color, "a0"))
      .font_family("Galmuri9").text_size(10).text_color(color).child(text);
  }

  header(t, w, q) {
    const at = q.indexOf(this.current);
    const many = q.length > 1;
    const chip = div().flex_none().px(6).h(18).flex().items_center().text_size(12);
    return h_flex().h(22).flex_none().gap(8).items_center()
      .child(w
        ? chip.bg(t.blocked).text_color("#1a0f2e").child("HELP!").loop("opacity", { from: 0.55, to: 1, period: 900 })
        : chip.border(1).border_color(t.idle ?? t.dim).text_color(t.idle ?? t.dim).child("CAMP"))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .child(w ? `${w.ch.name} calls for help!` : "Quest board"))
      .when(many, (el) => el
        .child(div().id("ph-prev").px(4).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent))
          .on_click((_e, cx) => this.step(-1, cx)).child("◀"))
        .child(div().flex_none().font_family("Galmuri9").text_size(10).text_color(t.muted).child(`${at < 0 ? 1 : at + 1} of ${q.length}`))
        .child(div().id("ph-next").px(4).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent))
          .on_click((_e, cx) => this.step(1, cx)).child("▶")))
      .child(div().id("ph-esc").flex_none().px(5).font_family("Galmuri9").text_size(10).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.accent)).on_click(() => this.close()).child("Esc"));
  }

  portrait(t, ch) {
    return v_flex().flex_none().w(84).gap(4).items_center()
      .child(div().relative().size(84).flex_none().border(2).border_color(ch.color).bg(alpha(t.background, "c0"))
        .child(image(facePath(ch)).absolute().left(4).top(4).size(72))
        .child(div().absolute().right(3).top(1).text_size(14).text_color(t.blocked).child("!").loop("opacity", { from: 0.2, to: 1, period: 700 })))
      .child(div().max_w(84).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(ch.role));
  }

  // What the member says: the prompt's heading, what it is about, and its question
  speech(t, w, r) {
    const ask = r?.ask;
    const lines = [];
    if (ask) {
      const body = ask.body.slice(0, BODY_LINES);
      const more = ask.body.length - body.length;
      const question = () => {
        if (ask.question) lines.push(div().w_full().text_size(13).text_color(t.foreground).child(cut(ask.question, 120)));
      };
      if (ask.heading) lines.push(div().w_full().truncate().text_size(12).text_color(t.accent).child(ask.heading));
      if (ask.questionFirst) question();
      body.forEach((l) => lines.push(div().w_full().truncate().pl(8).font_family("Galmuri9").text_size(10).text_color(mix(t.foreground, "#ffffff", 0.3)).child(l)));
      if (more > 0) lines.push(div().pl(8).font_family("Galmuri9").text_size(10).text_color(t.dim).child(`… ${more} more line${more > 1 ? "s" : ""}`));
      if (!ask.questionFirst) question();
    } else if (r?.error) {
      lines.push(div().text_size(12).text_color(t.blocked).child(cut(r.error, 120)));
    } else if (r) {
      lines.push(div().text_size(12).text_color(t.muted).child("I can't read a question here. The last lines of the screen:"));
    } else {
      lines.push(div().text_size(12).text_color(t.dim).child("Reading the screen…"));
    }
    const where = [w.space, w.tab].filter(Boolean).join(" › ");
    return v_flex().flex_1().min_w(0).gap(4)
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_none().text_size(14).text_color(w.ch.color).child(w.ch.name))
        .child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.muted).child(where || this.current || ""))
        .when(Boolean(w.program), (el) => el.child(this.small(t, w.program, /codex/i.test(w.app ?? "") ? t.unknown ?? t.muted : t.accent))))
      .child(this.window(t, v_flex().w_full().min_h(64).px(10).py(7).gap(3))
        .children(lines)
        .child(div().absolute().right(6).bottom(2).text_size(10).text_color(t.accent).child("▼").loop("opacity", { from: 0, to: 1, period: 800 })));
  }

  option(t, o, i, ask, on) {
    const free = o.free || ask.multi || !ask.answerable;
    const fg = on ? t.foreground : free ? t.muted : mix(t.foreground, t.muted, 0.25);
    const box = o.checked === null ? null : o.checked ? "■" : "□";
    return h_flex().id(`ph-opt-${o.n}`).w_full().min_w(0).flex_none().px(6).py(3).gap(6).items_start().cursor_pointer()
      .border(1).border_color(on ? alpha(t.accent, "c0") : alpha(t.accent, "00")).bg(on ? alpha(t.accent, "1f") : alpha(t.accent, "00"))
      .hover((s) => s.bg(alpha(t.accent, "14")))
      .on_click((_e, cx) => this.choose(i, cx))
      .child(div().w(10).h(16).flex_none().flex().items_center()
        .when(on, (el) => el.child(svg(ICON("cursor")).size(9).text_color(t.accent))))
      .child(div().w(18).h(16).flex_none().flex().items_center().text_size(12).text_color(on ? t.accent : t.dim).child(`${o.n}.`))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().w_full().min_w(0).h(16).gap(6).items_center()
          .when(Boolean(box), (el) => el.child(div().flex_none().font_family("Galmuri9").text_size(10).text_color(t.dim).child(box)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(fg).child(o.label))
          .when(o.free, (el) => el.child(this.small(t, "type in terminal", t.dim)))
          .when(Boolean(o.hint) && !o.free, (el) => el.child(this.small(t, o.hint, t.dim))))
        .children(o.details.map((d) => div().w_full().truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(d))));
  }

  choices(t, r) {
    const ask = r?.ask;
    if (!ask) {
      if (!r?.tail?.length) return div();
      return this.window(t, v_flex().w_full().flex_1().min_h(0).px(8).py(6).overflow_hidden())
        .children(r.tail.map((l) => div().w_full().truncate().font_family("Galmuri9").text_size(10).text_color(t.muted).child(l || " ")));
    }
    const note = ask.why === "multi" ? "Several can be picked — answer in the terminal"
      : ask.why === "typing" ? "The terminal is on a text box — answer there" : null;
    return v_flex().w_full().flex_1().min_h(0).gap(2).overflow_hidden()
      .when(Boolean(note), (el) => el.child(div().pb(2).font_family("Galmuri9").text_size(10).text_color(t.working).child(note)))
      .children(ask.options.map((o, i) => this.option(t, o, i, ask, i === this.sel)));
  }

  status(t) {
    // while waiting, the note says what was sent
    const text = this.busy === "checking" ? "Reading the question again…" : this.note?.text ?? null;
    if (!text) return div().h(14).flex_none();
    const color = this.busy !== "checking" && this.note?.tone === "warn" ? t.blocked : t.accent;
    return h_flex().h(14).flex_none().gap(6).items_center().font_family("Galmuri9").text_size(10).text_color(color)
      .when(Boolean(this.busy), (el) => el.child(div().id("ph-wait").w(10).frames(["◐", "◓", "◑", "◒"], 160)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  footer(t) {
    const ask = this.reads[this.current]?.ask;
    const hint = ask?.answerable ? "1–9 answer · ↑↓ Enter · Tab next · Esc close" : "Enter go to terminal · Tab next · Esc close";
    return h_flex().h(28).flex_none().gap(8).items_center()
      .child(this.button(t, "ph-go", "Go to terminal", "monitor", () => this.goTo(this.current), !ask?.answerable))
      .child(div().flex_1())
      .child(div().flex_none().font_family("Galmuri9").text_size(10).text_color(t.dim).child(hint));
  }

  nobody(t) {
    const ch = ROSTER[0];
    return v_flex().flex_1().min_h(0).gap(10).items_center().justify_center()
      .child(div().relative().size(84).border(2).border_color(alpha(ch.color, "a0")).bg(alpha(t.background, "c0"))
        .child(image(facePath(ch)).absolute().left(4).top(4).size(72).opacity(0.85)))
      .child(div().text_size(14).text_color(t.foreground).child("No one needs you right now"))
      .child(div().font_family("Galmuri9").text_size(10).text_color(t.dim).child("The party walks on. Rest a while — Esc to close."));
  }

  render() {
    const t = theme();
    const q = this.queue();
    const address = this.current;
    const w = address ? this.who(address) : null;
    const r = address ? this.reads[address] : null;
    const root = v_flex().id("pixel-help").track_focus(this.handle).size_full().min_h(0).p(14).gap(8)
      .text_color(t.foreground).text_size(12)
      .on_key_down((e, cx) => this.onKey(e, cx));
    const framed = this.window(t, root);
    if (!address) {
      return framed.child(this.header(t, null, q)).child(this.nobody(t))
        .child(h_flex().h(20).flex_none().justify_end().font_family("Galmuri9").text_size(10).text_color(t.dim).child("Esc close"));
    }
    return framed
      .child(this.header(t, w, q))
      .child(h_flex().w_full().min_w(0).flex_none().gap(12).items_start()
        .child(this.portrait(t, w.ch))
        .child(this.speech(t, w, r)))
      .child(this.choices(t, r))
      .child(this.status(t))
      .child(this.footer(t));
  }
}
