// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-account" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, which account and model an agent runs on (with its weekly
// use), and the agent's status; buttons split, zoom and close this pane.
// Props from the app: { pane, terminal }. Click: focus the pane.
// (A clone of the shipped `pane` mod, with the account chip added.)

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, appHome, terminals, shared, exec } from "herdr";

const isAgent = (p) => p?.program?.key === "claude" || p?.program?.key === "codex" || /claude|codex/i.test(p?.app ?? "");

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// The account and model an agent pane was started with: Herdr's tabs run their agent in the
// shell as `& 'claude2' '--resume' ... '--model' 'x'`. Null when the agent was typed by hand.
function launched(terminal) {
  const argv = terminals().find((k) => k.address === terminal)?.argv ?? [];
  const words = argv.flatMap((a) => String(a).match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));
  const at = words.findIndex((w) => /^(claude|codex)\d*(\.cmd|\.exe)?$/i.test(w.split(/[\\/]/).pop()));
  if (at < 0) return null;
  const flag = (...names) => {
    const i = words.findIndex((w, n) => n > at && names.includes(w));
    return i >= 0 ? words[i + 1] : null;
  };
  return { account: words[at].split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, "").toLowerCase(), model: flag("--model", "-m") };
}

// claude-opus-5-5 → Opus 5.5; others stay as they are.
const modelName = (m) => (m ?? "").replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, n, a, b) => `${n[0].toUpperCase()}${n.slice(1)} ${a}.${b}`);

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    // An agent typed into the shell ("claude2", "codex3") has no account in Herdr's argv:
    // who.py reads it from the running claude.exe / codex.exe. { key, at, account?, model?, error? }
    this.found = null;
    this.asking = false;
    cx.spawn(async (cx) => this.check(cx));
    cx.timer.every(3000, (cx) => this.check(cx));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Asks who.py when this pane runs a hand-started agent we haven't placed yet (again every
  // 2 minutes, and from scratch once the agent quits, so "claude" then "claude2" is caught).
  check(cx) {
    const p = this.me();
    if (!p?.terminal || !isAgent(p) || launched(p.terminal)) {
      if (this.found) { this.found = null; cx.notify(); }
      return;
    }
    const key = `${p.terminal}|${p.app ?? p.program?.key}`;
    const fresh = this.found && this.found.key === key && Date.now() - this.found.at < 120000;
    if (fresh || this.asking) return;
    this.asking = true;
    cx.spawn(async (cx) => {
      let found = { key, at: Date.now(), error: "확인 실패" };
      try {
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/pane-account/who.py`, p.terminal]);
        const out = JSON.parse(r.stdout || "{}");
        found = out.account ? { key, at: Date.now(), account: out.account, model: out.model ?? null } : { key, at: Date.now(), error: out.error || "확인 실패" };
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

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-account/${icon}.svg`).size(14));
  }

  // "claude2 · Opus 5.5 · 주간 3%" for an agent pane; the tooltip has the login and the details.
  account(t, p) {
    if (!isAgent(p)) return null;
    const key = `${p.terminal}|${p.app ?? p.program?.key}`;
    const found = this.found?.key === key ? this.found : null;
    const start = launched(p.terminal) ?? (found?.account ? { account: found.account, model: found.model } : null);
    if (!start) {
      const why = found?.error ? `셸에서 직접 실행한 에이전트인데 계정을 읽지 못했어요.\n(${found.error})` : "계정을 확인하는 중이에요.";
      return div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.dim)
        .id(`pa-${p.pane}`).tooltip(why).child("계정 ?");
    }
    const info = (shared(start.account.startsWith("codex") ? "sessions.codex" : "sessions.claude")?.accounts ?? []).find((a) => a.name === start.account);
    const usage = shared("usage.accounts")?.[start.account];
    // A resumed Codex thread keeps its own model unless one was passed.
    const model = start.model ?? (start.account.startsWith("claude") ? info?.model : null);
    const used = usage?.used;
    const level = used == null ? t.dim : used >= 90 ? t.blocked : used >= 70 ? t.working : t.muted;
    const parts = [start.account, modelName(model), used != null ? `${usage.window ?? "주간"} ${used}%` : null].filter(Boolean);
    const tip = [
      `계정: ${start.account}${usage?.login || info?.email ? ` · ${usage?.login || info?.email}` : ""}`,
      model ? `모델: ${model}` : "모델: 작업에 저장된 모델",
      used != null ? `${usage.window ?? "주간"} 사용량: ${used}%` : null,
      usage?.warning ? `⚠ ${usage.warning}` : null,
    ].filter(Boolean).join("\n");
    return div().id(`pa-${p.pane}`).flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5)
      .text_color(usage?.warning ? t.working : level).tooltip(tip).child(parts.join(" · "));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const chip = this.account(t, p);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(chip), (el) => el.child(chip))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
