// Finds a Claude or Codex session by its title or folder (Ctrl+Shift+S, or a panel's search
// button). Type to filter (every word must match), ↑/↓ and Enter to open, a right click for the
// panel's menu, Tab or the chips to switch between all / Claude / Codex, Esc to leave.
// It reads the lists the session panels last saved and hands the pick to that panel, so opening
// works exactly like a click there (accounts, the desktop app question, a tab already open).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { home, readTextFile, run, theme, props, closeOverlay, shared, setShared } from "herdr";

const STORE = () => `${home()}/AppData/Local/herdr-sessions`;
const KINDS = [{ id: "all", label: "All" }, { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }];
const ROW = 38;
const SHOWN = 11;

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const base = (path) => (path ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";

export default class SessionSearch extends View {
  init(_props, cx) {
    this.items = [];
    this.filter = "";
    this.at = 0;
    this.top = 0;
    // A panel's search button says which list to start on.
    this.kind = shared("sessions.search.kind") ?? "all";
    if (shared("sessions.search.kind")) setShared("sessions.search.kind", null);
    this.input = InputState.new({ placeholder: "Search by title or folder…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.top = 0;
      cx.notify();
    });
    this.input.on("submit", () => this.pick(this.rows()[this.at], "open"));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const read = async (name) => {
        try {
          return JSON.parse((await readTextFile(`${STORE()}/${name}`)) ?? "null");
        } catch {
          return null;
        }
      };
      const claude = await read("claude-list.json");
      const codex = await read("codex-list.json");
      const hiddenClaude = new Set(shared("sessions.hidden.claude") ?? []);
      const hiddenCodex = new Set(shared("sessions.hidden.codex") ?? []);
      this.items = [
        ...(claude?.sessions ?? []).filter((s) => !s.archived).map((s) => ({
          agent: "claude", id: s.cli, title: s.title || "(untitled)", cwd: s.cwd, last: s.last ?? 0,
          linked: Boolean(s.link), busy: s.desktop ? "app" : null, hidden: hiddenClaude.has(s.cli),
        })),
        ...(codex?.threads ?? []).map((s) => ({
          agent: "codex", id: s.id, title: s.title || "(untitled)", cwd: s.cwd, last: s.last ?? 0,
          linked: Boolean(s.link), busy: s.open ? "open" : null, hidden: hiddenCodex.has(s.id),
        })),
      ].sort((a, b) => b.last - a.last);
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((s) => (this.kind === "all" || s.agent === this.kind) &&
      words.every((w) => `${s.title} ${s.cwd ?? ""}`.toLowerCase().includes(w)));
  }

  // The panel that owns the session opens it (or shows its menu) as if it were clicked there.
  pick(s, what) {
    if (!s) return;
    this.close();
    setShared(`sessions.request.${s.agent}`, { id: s.id, what, at: Date.now() });
    run(`${s.agent}-sessions.request`);
  }

  setKind(kind, cx) {
    this.kind = kind;
    this.at = 0;
    this.top = 0;
    cx.notify();
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    // A window of rows that follows the selection; the wheel moves it.
    if (this.at < this.top) this.top = this.at;
    if (this.at >= this.top + SHOWN) this.top = this.at - SHOWN + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - SHOWN)));
    const shown = rows.slice(this.top, this.top + SHOWN);

    const tag = (text, color) => div().flex_none().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(color).flex().items_center().child(text);
    const row = (s, i) => {
      const on = this.top + i === this.at;
      return h_flex()
        .id(`ss-${s.agent}-${s.id}`)
        .mx(4)
        .px(10)
        .h(ROW)
        .gap(10)
        .rounded(7)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((el) => el.bg(t.hover))
        .on_click(() => this.pick(s, "open"))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.pick(s, "menu");
        })
        .child(div().w(46).flex_none().text_size(10.5).font_medium().text_color(s.agent === "claude" ? t.ansi3 : t.ansi4).child(s.agent === "claude" ? "Claude" : "Codex"))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(s.hidden ? t.dim : t.foreground).child(s.title))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(s.cwd ?? "")))
        .when(s.linked, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("⇄")))
        .when(s.hidden, (el) => el.child(tag("hidden", t.dim)))
        .when(Boolean(s.busy), (el) => el.child(tag(s.busy, t.dim)))
        .child(div().w(40).flex_none().text_right().text_size(11).text_color(t.dim).child(ago(s.last)));
    };

    return v_flex()
      .id("session-search")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = Math.min(rows.length - 1, this.at + 1);
        else if (k === "up") this.at = Math.max(0, this.at - 1);
        else if (k === "pagedown") this.at = Math.min(rows.length - 1, this.at + SHOWN);
        else if (k === "pageup") this.at = Math.max(0, this.at - SHOWN);
        else if (k === "tab") {
          const i = KINDS.findIndex((x) => x.id === this.kind);
          return this.setKind(KINDS[(i + (e.modifiers.shift ? KINDS.length - 1 : 1)) % KINDS.length].id, cx);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Find a session"))
        .children(KINDS.map((k) => div()
          .id(`ss-kind-${k.id}`)
          .px(9)
          .h(24)
          .rounded(6)
          .flex()
          .items_center()
          .text_size(11.5)
          .cursor_pointer()
          .bg(this.kind === k.id ? t.selected : t.popover)
          .text_color(this.kind === k.id ? t.foreground : t.dim)
          .hover((el) => el.text_color(t.foreground))
          .on_click((_e, cx) => this.setKind(k.id, cx))
          .child(k.label)))
        .child(div().ml(6).text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child(`${rows.length}`)))
      .child(v_flex()
        .id("ss-list")
        .h(SHOWN * ROW)
        .min_h(0)
        .overflow_hidden()
        .on_scroll_wheel((e, cx) => {
          const step = e.delta.y < 0 ? 1 : e.delta.y > 0 ? -1 : 0;
          this.top = Math.max(0, Math.min(this.top + step, Math.max(0, rows.length - SHOWN)));
          this.at = Math.max(this.top, Math.min(this.at, this.top + SHOWN - 1));
          cx.notify();
        })
        .when(!rows.length, (el) => el.child(div().px(14).py(10).text_size(12).text_color(t.dim)
          .child(this.items.length ? "No matching sessions." : "Reading the lists… (search works once the panels have read them)")))
        .children(shown.map(row)))
      .child(div().text_size(10.5).text_color(t.dim).child("Enter open · Right-click other account or agent · Tab switch All / Claude / Codex"));
  }
}
