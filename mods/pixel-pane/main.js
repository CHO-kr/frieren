// Pixel pane: two views of the shown tab's Frieren party (pixel-party reads the agents' screens and shares what they
// do as shared("pixel.activity")).
//   { "mod": "pixel-pane", "props": { "stage": true } }   a layout block: the battle stage. One strip of the background
//       where the shown tab's party (one member per pane, each a different character) acts out what its agents do
//       (plan.js: a battle in three waves while any works, each kind of work its own move, specials when the SP gauge
//       is full; a pastime at camp; a victory), with the battle log beside it. Each member's turns go through the
//       kinds of work its agent did in the last KIND_MS; a change of kinds alone re-plans at most every REPLAN_MS, so
//       a battle isn't cut off every time the agent starts another tool (a new status or party re-plans at once).
//   the pane header ({ pane, terminal } from the app): one slim row: the pane's character and name, what it is doing,
//       folder, the agent's account and model with its usage, status, and on hover split / zoom / close.
//       Click: focus the pane.
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pixel-pane" }, "height": 30 } } }
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, agents, props, run, theme, home, appHome, terminals, shared, exec, checking, focused, spaces, layout, readTextFile, window as herdrWindow } from "herdr";
import { battleLine, partyFor, isAgentPane, launched, modelName, ART, alpha, mix, ACTING, ROSTER, familyOf, layered, layerFile } from "./lib.js";
import { STAGE } from "./stage.js";
import { plan, glyphs, isNight, hash, MAX_PARTY, STEP, SLOT_MS } from "./plan.js";

const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const Z = ART.scale;
const STAGE_H = STAGE.height * Z;
const GLYPH_H = STAGE.glyphHeight * Z;
const LOG_W = 300; // the battle log beside the stage, at least
const KIND_MS = 5 * 60 * 1000; // the kinds of work a member's turns go through: what its agent did this recently
const REPLAN_MS = 60 * 1000; // new kinds alone wait this long before the battle is planned again

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// macOS draws colour fonts in one colour, so there a sprite is a stack of one-colour texts (lib.js layered), from the
// fonts' layer maps: loaded once by loadLayers, keyed by family. Elsewhere (and until they load) the colour glyphs.
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const LAYERS = new Map();
const STACKS = new Map(); // family + frames -> layered(): the same frames come back on every render
async function loadLayers(families) {
  if (herdrWindow()?.platform !== "macos") return false;
  let added = false;
  for (const family of families) {
    if (LAYERS.has(family)) continue;
    const map = parse(await readTextFile(`${appHome()}/mods/pixel-party/fonts/${layerFile(family)}`).catch(() => null));
    if (map?.g && map.palette) { LAYERS.set(family, map); added = true; }
  }
  return added;
}
// The layers of one stage item, or null where its font draws in colour (or its map hasn't loaded yet).
function stackOf(family, list, ms) {
  const map = LAYERS.get(family);
  if (!map) return null;
  const key = `${family}|${ms}|${list.join("\u0001")}`;
  let stack = STACKS.get(key);
  if (!stack) {
    if (STACKS.size > 600) STACKS.clear();
    STACKS.set(key, (stack = layered(map, list)));
  }
  return stack;
}
// el: the sprite's box, with its font, size and line height; the frames show in it, switched natively.
function drawGlyphs(el, list, ms, stack) {
  if (!stack) return list.length > 1 ? el.frames(list, ms) : el.child(list[0] ?? "");
  // every view shares one frame clock, so layers with the same frames and ms switch together
  return el.children(stack.map((l, i) => {
    const d = div().id(`l${i}`).absolute().left(0).top(0).whitespace_nowrap().text_color(l.color);
    return l.list.length > 1 ? d.frames(l.list, ms) : d.child(l.list[0] ?? "");
  }));
}

// The stage's sprites, as a retained child view: its description is kept until the plan changes (set_props), so the
// stage's other redraws (the log, focus, agents) don't rebuild hundreds of animated glyphs, or thousands of layers
// on macOS. props: { items: [{ key, x, y, w, family, frames, ms, stack }] }.
class StageSprites extends View {
  init(p) { this.items = p?.items ?? []; }
  update(p) { this.items = p?.items ?? []; }
  render() {
    return div().id("stage-sprites").absolute().left(0).top(0).size_full().children(this.items.map((it) => {
      const el = div().id(`st-${it.key}`).absolute().left(it.x * Z).top(it.y * Z).w(it.w * Z).h(GLYPH_H).overflow_hidden()
        .font_family(it.family).text_size(GLYPH_H).line_height(1).whitespace_nowrap();
      return drawGlyphs(el, it.frames, it.ms, it.stack);
    }));
  }
}
const spriteItems = (sc) => (sc?.items ?? []).map((it) => {
  const frames = glyphs(it);
  return { key: it.key, x: it.x, y: it.y, w: it.w, family: it.family, frames, ms: it.ms, stack: stackOf(it.family, frames, it.ms) };
});

const makePlan = (job) => ({ base: job.base, full: job.full, at: job.at, sc: job.args ? plan(...job.args) : null });
const sceneNow = () => (STAGE.scenes[shared("pixel.scene")] ? shared("pixel.scene") : "night");
const tabParty = (tab, ownPane) => partyFor(panes().filter((q) => q.tab === tab), agents(), shared("journey.party") ?? {},
  shared("pixel.activity") ?? {}, ownPane, MAX_PARTY);

export default class PixelPane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.found = null; // who.py's answer for an agent typed by hand: { key, at, account?, model?, error? }
    this.asking = false;
    this.cache = null; // { base, full, at, sc }
    this.seen = new Map(); // pane -> [{ kind, at }]: the kinds of work its agent did lately, in the order first seen
    this.pending = false; // new kinds wait for REPLAN_MS
    this.want = null; // a battle render asked for: planned on the timer below, not in render
    this.timed = false;
    if (checking()) return;
    if (props()?.stage) {
      const stageFonts = ["Monsters", "Fx", "Props", "Special"].map((k) => `FrierenDot${STAGE.version} ${k}`);
      this.sprites = cx.new(StageSprites, { items: [] });
      cx.spawn(async (cx) => { if (await loadLayers([...ROSTER.map(familyOf), ...stageFonts])) this.sprites.set_props({ items: spriteItems(this.cache?.sc) }); });
      // Planning a long battle takes a while in the app's script engine, and a render that runs too long is cut off,
      // so render only asks for a plan (this.want) and keeps drawing the last one; this makes it and redraws.
      this.timed = true;
      cx.timer.every(150, (cx) => {
        const job = this.want;
        if (!job) return;
        this.want = null;
        this.cache = makePlan(job);
        this.sprites.set_props({ items: spriteItems(this.cache.sc) });
        cx.notify();
      });
      // the window's width and the clock's 20-minute slot change without anything else re-rendering us
      this.size = null;
      cx.timer.every(2000, (cx) => {
        const w = globalThis.window?.viewport_size?.()?.width ?? null;
        const slot = Math.floor(Date.now() / SLOT_MS);
        const due = this.pending && Date.now() - (this.cache?.at ?? 0) >= REPLAN_MS;
        if (due || w !== this.size?.w || slot !== this.size?.slot || isNight() !== this.size?.night) {
          this.size = { w, slot, night: isNight() };
          cx.notify();
        }
      });
      return;
    }
    cx.spawn(async (cx) => this.check(cx));
    cx.timer.every(3000, (cx) => this.check(cx));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  check(cx) {
    const p = this.me();
    if (!p?.terminal || !isAgentPane(p) || launched(terminals().find((k) => k.address === p.terminal)?.argv)) {
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
        const r = await exec(herdrWindow()?.platform === "windows" ? "python" : "python3", ["-X", "utf8", `${appHome()}/mods/pane-account/who.py`, p.terminal]);
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
    return div().id(id).p(3).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(ICON(icon)).size(13));
  }

  chip(t, id, text, color, tip) {
    return div().id(id).flex_none().px(5).h(16).flex().items_center().border(1).border_color(color)
      .font_family("Galmuri9").text_size(10).text_color(color).when(Boolean(tip), (el) => el.tooltip(tip)).child(text);
  }

  account(t, p) {
    if (!isAgentPane(p)) return null;
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

  // ---------------------------------------------------------------- the pane header: one row
  header(t, p) {
    const party = tabParty(p.tab, p.pane);
    const mine = party.find((m) => m.own) ?? party[0];
    const pane = p.pane;
    if (!mine) return div().id(`pane-head-${pane}`).size_full().bg(alpha(t.chrome, "f0"));
    const { ch, st, act } = mine;
    const line = battleLine(ch, st, act);
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const focusedHere = p.focused;
    const chip = this.account(t, p);
    const lineColor = st === "blocked" ? t.blocked : st === "done" ? t.done : st === "working" ? mix(t.working, "#ffffff", 0.45) : t.muted;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pl(6)
      .pr(4)
      .gap(8)
      .items_center()
      .bg(focusedHere ? alpha(t.surface, "f2") : alpha(t.chrome, "f0"))
      .border_b(2)
      .border_color(focusedHere ? t.accent : alpha(t.border, "80"))
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(focusedHere, (el) => el.child(svg(ICON("cursor")).size(10).flex_none().text_color(t.accent)))
      .child(div().flex_none().size(8).bg(ch.color).border(1).border_color(alpha(t.background, "")))
      .child(div().flex_none().text_color(ch.color).child(ch.name))
      .child(div().flex_none().truncate().max_w(200).text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(lineColor)
        .tooltip(line.detail ? `${line.text}\n${line.detail}` : line.text)
        .child(line.detail ? `${line.text}  ${line.detail}` : line.text))
      .child(div().flex_none().max_w(220).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(chip), (el) => el.child(chip))
      .when(st === "blocked", (el) => el.child(this.chip(t, `need-${pane}`, "Needs you", t.blocked)))
      .when(st === "done", (el) => el.child(this.chip(t, `done-${pane}`, "Done", t.done)))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }, "Split right"))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }, "Split down"))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, p.zoomed ? "Restore size" : "Zoom"))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }, "Close")));
  }

  // ---------------------------------------------------------------- the stage block
  stageWidth() {
    // the work column: the window, less the layout's padding, the sidebar and the gap, the block's border and the log
    const vw = globalThis.window?.viewport_size?.()?.width ?? 1600;
    const side = find(layout(), "sidebar")?.size?.px ?? 292;
    const work = vw - 16 - side - 8 - 4;
    return Math.max(200, Math.min(STAGE.stripWidth, Math.floor((work - LOG_W) / Z)));
  }

  stage(t) {
    const f = focused();
    const tabId = f?.tab ?? null;
    const tab = spaces().flatMap((s) => s.tabs).find((x) => x.id === tabId) ?? null;
    const party = tabId ? tabParty(tabId, f?.pane ?? null) : [];
    const sceneId = sceneNow();
    const night = isNight();
    const W = this.stageWidth();
    const ms = Date.now();
    const pick = hash(tabId ?? "") + Math.floor(ms / SLOT_MS);
    // what each working member's agent did lately: its turns go through these (thinking only when there's nothing else)
    for (const m of party) {
      if (m.st !== "working" || !m.anim) continue;
      const list = (this.seen.get(m.key) ?? []).filter((e) => ms - e.at < KIND_MS);
      const e = list.find((x) => x.kind === m.anim);
      if (e) e.at = ms;
      else list.push({ kind: m.anim, at: ms });
      this.seen.set(m.key, list);
    }
    const kindsOf = (m) => {
      if (m.st !== "working") return [m.anim];
      const ks = (this.seen.get(m.key) ?? []).map((e) => e.kind);
      const real = ks.filter((k) => k !== "think");
      return (real.length ? real : ks).slice(-4);
    };
    const members = party.map((m) => ({ ...m, kinds: kindsOf(m) }));
    const base = JSON.stringify([party.map((m) => [m.ch.id, m.st, m.own]), sceneId, night, W, pick]);
    const full = JSON.stringify([base, members.map((m) => [m.kinds, m.summons ?? 0])]);
    if (!this.cache || this.cache.base !== base || (this.cache.full !== full && ms - this.cache.at >= REPLAN_MS)) {
      const job = { base, full, at: ms, args: party.length ? [members, sceneId, night, W, pick] : null };
      if (this.timed) this.want = job;
      else this.cache = makePlan(job);
    }
    this.pending = (this.cache?.full ?? null) !== full;
    const sc = this.cache?.sc ?? null; // until the timer makes the new plan, the last one
    const off = Math.round((STAGE.stripWidth - W) * (STAGE.anchor[sceneId] ?? 0.5));
    const rim = alpha(t.foreground, "60");
    const strip = div().id("stage-strip").relative().flex_none().w(W * Z).h(STAGE_H).overflow_hidden().border_r(2).border_color(rim)
      .child(image(`mods/pixel-party/scenes/${sceneId}.png`).absolute().left(-off * Z).top(0).w(STAGE.stripWidth * Z).h(STAGE_H))
      .map((el) => (this.sprites ? el.child(this.sprites) : el.children(spriteItems(sc).map((it) =>
        drawGlyphs(div().id(`st-${it.key}`).absolute().left(it.x * Z).top(it.y * Z).w(it.w * Z).h(GLYPH_H).overflow_hidden()
          .font_family(it.family).text_size(GLYPH_H).line_height(1).whitespace_nowrap(), it.frames, it.ms, it.stack)))));
    // the log: what's happening, the line before, and who does what
    const title = !sc ? "No party here" : sc.mode === "battle" ? `BATTLE · vs ${sc.foe}` : sc.mode === "victory" ? "VICTORY" : `CAMP · ${night ? "night" : "day"}`;
    const color = !sc ? t.dim : sc.mode === "battle" ? t.working : sc.mode === "victory" ? t.done : t.muted;
    const [now, before] = sc?.log ?? [["Open a terminal to start a party."], [""]];
    const text = (id, list, el) => (list.length > 1 ? el.id(id).frames(list, STEP) : el.id(id).child(list[0] ?? ""));
    const doing = party.filter((m) => m.st === "working" || m.st === "blocked").map((m) =>
      `${m.ch.name}: ${m.st === "blocked" ? "needs you" : ACTING[m.anim] ?? "Acting"}${m.act?.detail && m.st === "working" ? ` ${m.act.detail}` : ""}`);
    const tip = party.length ? party.map((m) => `${m.ch.name}${m.own ? " (focused pane)" : ""} · ${m.st ?? "shell"}${m.act?.detail ? ` · ${m.act.detail}` : ""}`).join("\n") : "";
    return h_flex().id("pixel-stage").size_full().items_start().overflow_hidden().text_color(t.foreground)
      .child(strip)
      .child(v_flex().id("stage-log").flex_1().min_w(0).h(STAGE_H).px(10).py(2).gap(1).tooltip(tip)
        .child(h_flex().flex_none().w_full().min_w(0).h(17).gap(8).items_center()
          .child(sc?.title ? text("log-title", sc.title, div().flex_none().text_size(12).text_color(color))
            : div().flex_none().text_size(12).text_color(color).child(title))
          .child(div().flex_1().min_w(0).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim)
            .child([tab ? tab.name : "", party.map((m) => m.ch.name).join(" · ")].filter(Boolean).join("  —  "))))
        .child(text("log-now", now, div().flex_none().w_full().h(17).truncate().text_size(12).text_color(t.foreground)))
        .child(text("log-before", before, div().flex_none().w_full().h(15).truncate().font_family("Galmuri9").text_size(10).text_color(t.muted)))
        .child(div().flex_none().w_full().h(15).truncate().font_family("Galmuri9").text_size(10).text_color(t.dim).child(doing.join("  ·  "))));
  }

  render() {
    const t = theme();
    if (props()?.stage) return this.stage(t);
    const p = this.me();
    return p ? this.header(t, p) : div();
  }
}
