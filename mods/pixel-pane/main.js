// Pixel pane header: the session's party member on a little stage, acting out what the agent is doing
// (pixel-party reads the screens and shares it as shared("pixel.activity")), with an RPG battle line under the title.
// Also everything pane-account showed: name, folder, the agent's account and model with its usage, status, and on hover
// the split / zoom / close buttons. Props from the app: { pane, terminal }. Click: focus the pane.
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pixel-pane" }, "height": 70 } } }
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, agents, props, run, theme, home, appHome, terminals, shared, exec, checking } from "herdr";
import { ROSTER, character, familyOf, frames, battleLine, agentKey, launched, modelName, ART } from "./lib.js";

const isAgent = (p) => p?.program?.key === "claude" || p?.program?.key === "codex" || /claude|codex/i.test(p?.app ?? "");
const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const STAGE_W = ART.stage * ART.scale;
const SPR_H = ART.height * ART.scale;

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
    const ch = character(picks[agent ? agentKey(agent, all) : `tab:${p.tab}`]) ?? ROSTER[0];
    const st = agent?.status ?? (isAgent(p) ? p.status : null);
    const act = shared("pixel.activity")?.[p.terminal] ?? null;
    const line = battleLine(ch, st, act);
    const f = frames(line.anim, false);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pane = p.pane;
    const focused = p.focused;
    const chip = this.account(t, p);
    const lineColor = st === "blocked" ? t.blocked : st === "done" ? t.done : st === "working" ? "#bcd4ff" : t.muted;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pr(8)
      .gap(10)
      .items_center()
      .bg(focused ? "#1a2462f2" : "#121a4cf0")
      .border_b(2)
      .border_color(focused ? "#ffd36a" : "#7880c880")
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // the stage
      .child(div().id(`stage-${pane}`).relative().flex_none().w(STAGE_W + 2).h(SPR_H + 2).border_r(2).border_b(2).border_color("#efe6c860")
        .tooltip(`${ch.name} · ${ch.role}`)
        .child(image("mods/pixel-party/backdrop-stage.png").absolute().left(0).top(0).w(STAGE_W).h(SPR_H).when(st === "idle" || !st, (el) => el.opacity(0.7)))
        .child(div().id(`spr-${pane}`).absolute().left(0).top(0).w(STAGE_W).h(SPR_H).overflow_hidden()
          .font_family(familyOf(ch)).text_size(SPR_H).line_height(1).whitespace_nowrap().frames(f.list, f.ms)))
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
        .child(h_flex().w_full().min_w(0).h(22).px(8).gap(8).items_center().bg("#0b1030b3").border(1).border_color("#efe6c860")
          .child(div().flex_none().text_color(lineColor).child(line.text))
          .when(Boolean(line.detail), (el) => el.child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.muted).child(line.detail)))));
  }
}
