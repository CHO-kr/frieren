// Pixel pane header: a scene from the background (a 256 x 32 strip of it, scene.js) where the tab's party acts out what
// its agents are doing (pixel-party reads the screens and shares it as shared("pixel.activity")): while any of them works,
// the party (every pane of the tab, up to 4) faces the background's monster and a cast flies all the way to it; when all
// rest they camp, sharing a meal by the fire by day and asleep by night; when one is done, a treasure chest. This pane's
// member stands on a gold ring when the tab has more than one. An RPG battle line sits under the title.
// Also everything pane-account showed: name, folder, the agent's account and model with its usage, status, and on hover
// the split / zoom / close buttons. Props from the app: { pane, terminal }. Click: focus the pane.
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pixel-pane" }, "height": 72 } } }
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, agents, props, run, theme, home, appHome, terminals, shared, exec, checking } from "herdr";
import { ROSTER, character, battleLine, animFor, agentKey, launched, modelName, ART, alpha, mix } from "./lib.js";
import { SCENE } from "./scene.js";
import { plan, glyphs, isNight, MAX_PARTY } from "./plan.js";

const isAgent = (p) => p?.program?.key === "claude" || p?.program?.key === "codex" || /claude|codex/i.test(p?.app ?? "");
const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const SPR_H = ART.height * ART.scale;
const S = ART.scale;

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class PixelPane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.found = null; // who.py's answer for an agent typed by hand: { key, at, account?, model?, error? }
    this.asking = false;
    if (checking()) return;
    cx.spawn(async (cx) => this.check(cx));
    cx.timer.every(3000, (cx) => this.check(cx));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  check(cx) {
    const p = this.me();
    if (!p?.terminal || !isAgent(p) || launched(terminals().find((k) => k.address === p.terminal)?.argv)) {
      if (this.found) { this.found = null; cx.notify(); }
      return;
    }
    const key = `${p.terminal}|${p.app ?? p.program?.key}`;
    const fresh = this.found && this.found.key === key && Date.now() - this.found.at < 120000;
    if (fresh || this.asking) return;
    this.asking = true;
    cx.spawn(async (cx) => {
      let found = { key, at: Date.now(), error: "lookup failed" };
      try {
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/pane-account/who.py`, p.terminal]);
        const out = JSON.parse(r.stdout || "{}");
        found = out.account ? { key, at: Date.now(), account: out.account, model: out.model ?? null } : { key, at: Date.now(), error: out.error || "lookup failed" };
      } catch (e) {
        found.error = String(e?.message ?? e);
      }
      this.asking = false;
      if (JSON.stringify({ ...found, at: 0 }) !== JSON.stringify({ ...(this.found ?? {}), at: 0 })) {
        this.found = found;
        cx.notify();
      } else {
        this.found.at = found.at;
      }
    });
  }

  button(t, id, icon, command, args, tip) {
    return div().id(id).p(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(ICON(icon)).size(14));
  }

  chip(t, id, text, color, tip) {
    return div().id(id).flex_none().px(5).h(16).flex().items_center().border(1).border_color(color)
      .font_family("Galmuri9").text_size(10).text_color(color).when(Boolean(tip), (el) => el.tooltip(tip)).child(text);
  }

  account(t, p) {
    if (!isAgent(p)) return null;
    const key = `${p.terminal}|${p.app ?? p.program?.key}`;
    const found = this.found?.key === key ? this.found : null;
    const start = launched(terminals().find((k) => k.address === p.terminal)?.argv) ?? (found?.account ? { account: found.account, model: found.model } : null);
    if (!start) {
      const why = found?.error ? `Started by hand in a shell, so its account couldn't be read.\n(${found.error})` : "Checking account…";
      return this.chip(t, `pa-${p.pane}`, "account ?", t.dim, why);
    }
    const info = (shared(start.account.startsWith("codex") ? "sessions.codex" : "sessions.claude")?.accounts ?? []).find((a) => a.name === start.account);
    const usage = shared("usage.accounts")?.[start.account];
    const model = start.model ?? (start.account.startsWith("claude") ? info?.model : null);
    const used = usage?.used;
    const level = used == null ? t.dim : used >= 90 ? t.blocked : used >= 70 ? t.working : t.muted;
    const parts = [start.account, modelName(model), used != null ? `${usage.window ?? "weekly"} ${used}%` : null].filter(Boolean);
    const tip = [
      `Account: ${start.account}${usage?.login || info?.email ? ` · ${usage?.login || info?.email}` : ""}`,
      model ? `Model: ${model}` : "Model: the one saved with the task",
      used != null ? `${usage.window ?? "weekly"} usage: ${used}%` : null,
      usage?.warning ? `⚠ ${usage.warning}` : null,
    ].filter(Boolean).join("\n");
    return this.chip(t, `pa-${p.pane}`, parts.join(" · "), usage?.warning ? t.working : level, tip);
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const all = agents();
    const agent = all.find((a) => a.address === p.terminal) ?? null;
    const picks = shared("journey.party") ?? {};
    const acts = shared("pixel.activity") ?? {};
    // the tab's party: one member per pane (this one always among the first MAX_PARTY)
    const memberOf = (q) => {
      const ag = all.find((a) => a.address === q.terminal) ?? null;
      const c = character(picks[ag ? agentKey(ag, all) : `tab:${q.tab}`]) ?? ROSTER[0];
      const s = ag?.status ?? (isAgent(q) ? q.status : null);
      return { pane: q.pane, ch: c, st: s, act: acts[q.terminal] ?? null, anim: animFor(s, acts[q.terminal]), own: q.pane === p.pane };
    };
    let party = panes().filter((q) => q.tab === p.tab).map(memberOf);
    if (!party.some((m) => m.own)) party = [memberOf(p), ...party];
    if (party.length > MAX_PARTY) party = [...party.filter((m, i) => i < MAX_PARTY - 1 || m.own)].slice(0, MAX_PARTY);
    const mine = party.find((m) => m.own);
    const ch = mine.ch;
    const st = mine.st;
    const act = mine.act;
    const sceneId = SCENE.scenes[shared("pixel.scene")] ? shared("pixel.scene") : "night";
    const night = isNight();
    const sc = plan(party, sceneId, night);
    const line = battleLine(ch, st, act);
    const group = party.length > 1;
    const foe = sc.monster ? SCENE.monsters[sc.monster].name : null;
    if (sc.mode === "camp" && st === "idle") line.text = night ? (group ? "The party sleeps by the campfire… Zzz" : line.text) : `${group ? "The party shares" : `${ch.name} has`} a meal by the campfire`;
    if (sc.mode === "battle" && line.anim === "rest") line.text = `${ch.name} stands ready`;
    if (sc.mode === "battle" && foe) line.text += ` · vs ${foe}`;
    if (sc.mode === "victory" && st === "done") line.text = "Quest complete! Treasure found";
    const tip = `${party.map((m) => `${m.ch.name}${m.own && group ? " (this pane)" : ""}`).join(", ")}${foe ? ` vs ${foe}` : ""}`
      + `\n${sc.mode === "battle" ? "In battle while an agent works" : sc.mode === "victory" ? "A task is done" : night ? "Camping: asleep (22:00-07:00)" : "Camping: a meal by the fire"}`;
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pane = p.pane;
    const focused = p.focused;
    const chip = this.account(t, p);
    const lineColor = st === "blocked" ? t.blocked : st === "done" ? t.done : st === "working" ? mix(t.working, "#ffffff", 0.45) : t.muted;
    const rim = alpha(t.foreground, "60");
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pr(8)
      .gap(10)
      .items_center()
      .bg(focused ? alpha(t.surface, "f2") : alpha(t.chrome, "f0"))
      .border_b(2)
      .border_color(focused ? t.accent : alpha(t.border, "80"))
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // the scene: the background's strip, then props, the monster, the party (it gives way first in a narrow pane)
      .child(div().id(`stage-${pane}`).relative().flex_shrink(1).min_w(SCENE.slots[0] * S + 60).w(SCENE.width * S + 2).h(SPR_H + 2)
        .overflow_hidden().border_r(2).border_b(2).border_color(rim).tooltip(tip)
        .child(image(`mods/pixel-party/scenes/${sceneId}.png`).absolute().left(0).top(0).w(SCENE.width * S).h(SPR_H))
        .children(sc.items.map((it) => {
          const g = glyphs(it);
          const el = div().id(`sc-${pane}-${it.key}`).absolute().left(it.x * S).top(0).w(it.w * S).h(SPR_H).overflow_hidden()
            .font_family(it.family).text_size(SPR_H).line_height(1).whitespace_nowrap();
          return g.length > 1 ? el.frames(g, it.ms) : el.child(g[0]);
        })))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().w_full().min_w(0).gap(7).items_center()
          .when(focused, (el) => el.child(svg(ICON("cursor")).size(10).flex_none().text_color(t.accent)))
          .child(div().flex_none().text_color(ch.color).child(ch.name))
          .child(div().flex_none().truncate().max_w(240).text_color(t.foreground).child(name))
          .child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(folder(p.cwd)))
          .when(Boolean(chip), (el) => el.child(chip))
          .when(st === "blocked", (el) => el.child(this.chip(t, `need-${pane}`, "Needs you", t.blocked)))
          .when(st === "done", (el) => el.child(this.chip(t, `done-${pane}`, "Done", t.done)))
          .when(this.hovered, (el) => el
            .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }, "Split right"))
            .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }, "Split down"))
            .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, p.zoomed ? "Restore size" : "Zoom"))
            .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }, "Close"))))
        // the battle line, in a JRPG message box
        .child(h_flex().w_full().min_w(0).h(22).px(8).gap(8).items_center().bg(alpha(t.background, "b3")).border(1).border_color(rim)
          .child(div().flex_none().text_color(lineColor).child(line.text))
          .when(Boolean(line.detail), (el) => el.child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.muted).child(line.detail)))));
  }
}
