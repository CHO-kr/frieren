// Results: the newest files in the focused terminal's folder (images, video, sound, documents,
// code), with thumbnails. A click shows an image, Markdown or text in a preview window and opens
// anything else in its default app; "Attach" puts the file into the agent's prompt as if dropped
// there. Toggle with Ctrl+Shift+R. recent.py lists the files and makes the small pictures.
// LOOT DROPPED, on top: the newest files the agents of the shown tab made, wherever they saved
// them, from shared("pixel.loot") (pixel-chronicle keeps it: [{ path, at, terminal, kind? }],
// newest first, `at` in ms). Hidden when there is none.
// The same mod draws the preview window (props.preview, with props.list and props.index: the rows
// the panel showed when it opened, same filter and order). ← / → step through them, Home / End go
// to the first / last, Esc closes. A file it can't show gets a card with "Open in default app".
// The window also takes "results-panel.next" / ".prev" / ".first" / ".last" (keys.json).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { exec, focused, run, theme, settings, notify, appHome, home, layout, readTextFile, watchFolder, openOverlay, closeOverlay, props, shared, panes, terminals, spaces, nextCommand, checking } from "herdr";

const KINDS = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "media", label: "Video · audio", kinds: ["video", "audio"] },
  { id: "doc", label: "Docs" },
  { id: "code", label: "Code" },
];
const KIND_NAME = { image: "Image", video: "Video", audio: "Audio", doc: "Document", code: "Code" };
const TEXT = new Set(["md", "txt", "json", "csv", "srt", "vtt", "log", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "css", "sh", "bat", "cmd", "toml", "yaml", "yml", "xml"]);
const LANG = { ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", ps1: "bash", sh: "bash" };
const LOOT_ROWS = 6; // loot rows shown at most
const LOOT_ASK = 12; // newest loot of the tab whose facts are read (gone files and the filter thin them out)
const FRESH = 10 * 60000; // loot younger than this wears the "new" mark

const SCRIPT = () => `${appHome()}/mods/results-panel/recent.py`;
const SMALL = (el) => el.font_family("Galmuri9").text_size(10);
const alpha = (c, a) => `${String(c ?? "#000000").slice(0, 7)}${a}`;
const canPreview = (f) => f.kind === "image" || TEXT.has(f.ext);
// Paths from other mods may use forward slashes; Explorer and the clipboard want backslashes.
const fix = (p) => String(p ?? "").replace(/\//g, "\\");
const same = (p) => fix(p).toLowerCase();
// `at` should be ms since the epoch; seconds are taken too.
const toMs = (n) => (n > 0 && n < 1e11 ? n * 1000 : n);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const shown = () => find(layout(), "results")?.hidden !== true;

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function bytes(n) {
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)}GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
}

const short = (path) => {
  const h = home();
  return path && path.toLowerCase().startsWith(h.toLowerCase()) ? "~" + path.slice(h.length) : path ?? "";
};

// Windows does these: the default app for a file, and Explorer with the file selected.
const openFile = (path) => exec("powershell", ["-NoProfile", "-Command", "& { param($p) Invoke-Item -LiteralPath $p }", path]);
const reveal = (path) => exec("explorer.exe", [`/select,${path}`]);

// The file goes on the clipboard as a copied file and is pasted into the pane the agent is in,
// which Herdr does "as if dropped": the path lands in the prompt (Claude Code attaches an image).
async function attach(path, pane) {
  if (!pane) return notify({ title: "No pane to attach to", body: "Click a pane with an agent, then try again.", level: "info" });
  await exec("powershell", ["-NoProfile", "-Command", "& { param($p) Set-Clipboard -LiteralPath $p }", path]);
  run("pane.focus", { pane });
  run("terminal.paste");
}

// Who dropped a piece of loot, for its tooltip: the program in that terminal's pane, else the address.
function dropper(terminal) {
  const p = panes().find((x) => x.terminal === terminal);
  return p ? `${p.program?.name ?? p.title} (${terminal})` : terminal;
}

export default class Results extends View {
  init(_props, cx) {
    if (props()?.preview) return this.initPreview(cx);
    this.folder = null;
    this.files = null;
    this.kind = "all";
    this.locked = false;
    this.busy = false;
    this.dirty = false;
    this.last = 0;
    this.pane = null;
    this.hovered = null;
    this.loot = []; // recent.py's facts for the tab's newest loot, in that order
    this.lootKey = null; // the paths they were read for
    this.lootAt = 0;
    this.lootBusy = false;
    this.fresh = 0; // how many of the tab's loot wear the "new" mark
    this.follow(cx);
    this.lootCheck(cx);
    // Focus moves without telling a mod in a block, so look now and then (cheap: no programs run).
    cx.timer.every(1500, (cx) => {
      this.follow(cx);
      this.lootCheck(cx);
    });
    // The home folder has too much going on to watch; it is read again every minute while shown.
    cx.timer.every(60000, (cx) => {
      if (shown() && this.folder && this.isHome()) this.refresh(cx);
    });
  }

  isHome() {
    return this.folder?.toLowerCase() === home().toLowerCase();
  }

  // Follows the focused terminal's folder (unless pinned) and remembers its pane for "Attach".
  follow(cx) {
    const f = focused();
    if (f?.terminal && f.pane) this.pane = f.pane;
    if (!this.locked && f?.terminal && f.cwd && f.cwd !== this.folder) {
      this.folder = f.cwd;
      this.files = null;
      this.refresh(cx, true);
      this.watch(cx, this.folder);
    } else if (this.dirty && shown()) {
      this.refresh(cx);
    }
  }

  // Reads the list again. While hidden, or less than 10 s after the last reading (a render
  // writes files all the time), it only marks the list stale.
  refresh(cx, now = false) {
    if (!this.folder) return;
    if (!now && (!shown() || Date.now() - this.last < 10000 || this.busy)) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    this.dirty = false;
    const folder = this.folder;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", SCRIPT(), folder, "80"]);
        if (folder === this.folder) {
          this.error = r.code === 0 ? null : r.stderr.trim().split("\n").at(-1);
          if (r.code === 0) this.files = JSON.parse(r.stdout).files;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.last = Date.now();
      cx.notify();
    });
  }

  watch(cx, folder) {
    if (this.isHome()) return;
    cx.spawn(async (cx) => {
      while (folder === this.folder) {
        await watchFolder(folder);
        if (folder !== this.folder) break;
        await cx.sleep(2000); // a save comes as a burst
        this.refresh(cx);
      }
    });
  }

  // ---- loot: files the tab's agents made ----

  // The shown tab's newest loot, one entry per file: its terminals are the tab's panes and the
  // sub-agents those started (they belong to the tab without a pane).
  lootWanted() {
    const all = shared("pixel.loot");
    if (!Array.isArray(all) || !all.length) return [];
    const tab = focused()?.tab ?? spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
    if (!tab) return [];
    const mine = new Set(panes().filter((p) => p.tab === tab && p.terminal).map((p) => p.terminal));
    if (!mine.size) return [];
    try {
      const ts = terminals();
      for (let grew = true; grew; ) {
        grew = false;
        for (const t of ts) {
          if (t.parent && mine.has(t.parent) && t.address && !mine.has(t.address)) {
            mine.add(t.address);
            grew = true;
          }
        }
      }
    } catch {}
    const seen = new Set();
    const out = [];
    const newest = all.filter((e) => e && typeof e.path === "string" && e.path && mine.has(e.terminal))
      .map((e) => ({ path: fix(e.path), at: toMs(Number(e.at) || 0), terminal: e.terminal, kind: typeof e.kind === "string" ? e.kind : null }))
      .sort((a, b) => b.at - a.at);
    for (const e of newest) {
      const key = same(e.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length === LOOT_ASK) break;
    }
    return out;
  }

  // Reads the loot's facts when the wanted files change (a new drop, another tab) and every 30 s
  // while shown (a file may have been written again). Also redraws when a "new" mark runs out.
  lootCheck(cx) {
    const want = this.lootWanted();
    const now = Date.now();
    const fresh = want.filter((e) => now - e.at < FRESH).length;
    if (fresh !== this.fresh) {
      this.fresh = fresh;
      cx.notify();
    }
    if (!shown() || this.lootBusy) return;
    const key = want.map((e) => e.path).join("\n");
    if (key === this.lootKey && (!key || now - this.lootAt < 30000)) return;
    if (!key) {
      this.loot = [];
      this.lootKey = key;
      cx.notify();
      return;
    }
    this.lootBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", SCRIPT(), "--files", ...want.map((e) => e.path)]);
        if (r.code === 0) this.loot = JSON.parse(r.stdout).files;
      } catch {}
      this.lootKey = key;
      this.lootAt = Date.now();
      this.lootBusy = false;
      cx.notify();
    });
  }

  // The loot rows to show now: read facts joined with the tab's current loot (so another tab's
  // rows go at once), kinds the script doesn't know taken from the entry, then the filter.
  lootRows(match) {
    const want = this.lootWanted();
    if (!want.length) return [];
    const by = new Map(want.map((e) => [same(e.path), e]));
    const rows = [];
    for (const f of this.loot) {
      const e = by.get(same(f.path));
      if (!e) continue;
      const row = { ...f, kind: f.kind === "other" && e.kind ? e.kind : f.kind, at: e.at || f.mtime, terminal: e.terminal, loot: true };
      if (!match(row)) continue;
      rows.push(row);
      if (rows.length === LOOT_ROWS) break;
    }
    return rows;
  }

  // A click: images and text open in the preview window, which gets every row shown (`steps`)
  // to step through; anything else opens in its default app.
  open(f, steps) {
    if (!canPreview(f)) return openFile(f.path);
    openOverlay({
      mod: "results-panel", kind: "window", key: "result-preview", width: 0.62, height: 0.78,
      props: { preview: f, list: steps, index: Math.max(0, steps.indexOf(f)), pane: this.pane },
    });
  }

  // ---- the preview window ----

  initPreview(cx) {
    const p = props();
    this.list = Array.isArray(p.list) && p.list.length ? p.list : [p.preview];
    this.at = Math.min(Math.max(0, Number(p.index) || 0), this.list.length - 1);
    this.dir = 1; // the way the person steps, to make the next picture ahead of time
    this.pics = {}; // "path|mtime" -> its screen-sized copy, once made
    this.making = {}; // the same, while recent.py makes it
    this.seq = 0;
    this.handle = cx.focus_handle();
    this.handle.focus(); // a window doesn't take the keyboard by itself: this keeps the arrows working from the start
    this.load(cx);
    if (!checking()) {
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          const to = { next: this.at + 1, prev: this.at - 1, first: 0, last: this.list.length - 1 }[c];
          if (to !== undefined) this.step(to, cx);
        }
      });
    }
  }

  current() {
    return this.list[this.at];
  }

  // Goes to another row (clamped to the list) and gives the keyboard back to the window.
  step(to, cx) {
    this.handle.focus();
    const at = Math.max(0, Math.min(this.list.length - 1, to));
    if (at === this.at) return;
    this.dir = at < this.at ? -1 : 1;
    this.at = at;
    this.load(cx);
    cx.notify();
  }

  // An image's screen-sized copy, asked of recent.py once per file version (load and read-ahead
  // share it): { pic } or { gone } or {} (it couldn't be read).
  bigPicture(f) {
    const key = `${f.path}|${f.mtime}`;
    if (!this.making[key]) {
      this.making[key] = exec("python", ["-X", "utf8", SCRIPT(), "--preview", f.path])
        .then((r) => (r.code === 0 ? { pic: JSON.parse(r.stdout).image } : { gone: /FileNotFoundError/.test(r.stderr) }))
        .catch(() => ({}))
        .then((got) => {
          if (got.pic) this.pics[key] = got.pic;
          return got;
        });
    }
    return this.making[key];
  }

  // Makes the next picture in the stepping direction while this one is looked at.
  readAhead(cx) {
    const g = this.list[this.at + this.dir];
    if (g?.kind === "image" && !this.pics[`${g.path}|${g.mtime}`]) cx.spawn(async () => { await this.bigPicture(g); });
  }

  // Shows the current row: an image, Markdown, text or code; anything else gets the card.
  load(cx) {
    const f = this.current();
    const seq = ++this.seq;
    this.picture = null;
    this.text = null;
    this.code = null;
    this.problem = null;
    if (!canPreview(f)) return;
    const made = f.kind === "image" && this.pics[`${f.path}|${f.mtime}`];
    if (made) {
      this.picture = made;
      return this.readAhead(cx);
    }
    cx.spawn(async (cx) => {
      try {
        if (f.kind === "image") {
          const got = await this.bigPicture(f);
          if (seq !== this.seq) return;
          if (got.pic) this.picture = got.pic;
          else this.problem = got.gone ? "The file is gone." : "Couldn't make a picture of this image.";
        } else {
          const text = await readTextFile(f.path);
          if (seq !== this.seq) return;
          if (text === null) this.problem = "The file is gone.";
          else if (f.ext === "md") this.text = text;
          else {
            const t = theme();
            this.code = EditorState.new({ language: LANG[f.ext] ?? f.ext, readonly: true, value: text, font_family: settings().font_family, font_size: 12,
              syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
          }
        }
      } catch {
        if (seq !== this.seq) return;
        this.problem = "Too large or unreadable to preview here.";
      }
      cx.notify();
      this.readAhead(cx);
    });
  }

  preview(t) {
    const f = this.current();
    const pane = props().pane;
    const n = this.list.length;
    const button = (id, label, act, primary = false) => div()
      .id(id)
      .h(26)
      .px(10)
      .rounded(6)
      .flex()
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .hover((el) => (primary ? el.opacity(0.88) : el.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(act)
      .child(label);
    const arrow = (id, label, tip, to) => {
      const on = to >= 0 && to < n && to !== this.at;
      return div()
        .id(id)
        .w(22)
        .h(22)
        .flex_none()
        .rounded(4)
        .flex()
        .items_center()
        .justify_center()
        .text_size(11)
        .bg(t.raised)
        .text_color(on ? t.foreground : t.dim)
        .when(on, (el) => el.cursor_pointer().hover((el) => el.bg(t.hover).text_color(t.accent)))
        .when(!on, (el) => el.opacity(0.45))
        .tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.step(to, cx))
        .child(label);
    };
    // A file the window can't show (video, sound, PDF, ...), or one that failed: what it is, and a way out.
    const card = (note) => v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(24)
      .child(f.thumb
        ? div().w(320).h(180).flex_none().rounded(6).bg(t.raised).child(image(f.thumb).size_full())
        : div().w(96).h(72).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center().text_size(16).text_color(t.dim)
          .child((f.ext || "file").toUpperCase()))
      .child(div().max_w(560).text_center().text_size(15).text_color(t.foreground).child(f.name))
      .child(SMALL(div()).text_color(t.dim).child(`${KIND_NAME[f.kind] ?? "File"} · ${(f.ext || "no extension").toUpperCase()} · ${bytes(f.size)} · ${ago(f.mtime)}`))
      .when(Boolean(note), (el) => el.child(SMALL(div()).text_color(t.muted).child(note)))
      .child(div().pt(4).child(button("rp-card-open", "Open in default app", () => openFile(f.path), true)));
    const body = !canPreview(f) || this.problem
      ? card(this.problem)
      : this.picture
        ? div().flex_1().min_h(0).p(10).flex().items_center().justify_center().child(image(this.picture).size_full())
        : this.text !== null
          ? div().flex_1().min_h(0).px(18).py(10).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(TextView.markdown(`md-${f.path}`, this.text).selectable(true).scrollable(true).size_full())
          : this.code
            ? div().flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Editor.new(this.code).size_full())
            : div().p(16).text_color(t.dim).child("Opening…");
    return v_flex()
      .id("result-preview")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        // Only while the window itself has the keyboard: in the code view the arrows move the cursor.
        if (!this.handle.is_focused()) return;
        const m = e.modifiers ?? {};
        if (m.control || m.alt || m.platform || m.shift) return;
        const to = { left: this.at - 1, right: this.at + 1, home: 0, end: n - 1 }[e.key];
        if (to === undefined) return;
        this.step(to, cx);
        cx.stop_propagation();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        // A press on the title bar drags the window and takes the keyboard back from the code view.
        .on_mouse_down("left", () => this.handle.focus())
        .when(n > 1, (el) => el
          .child(arrow("rp-prev", "◀", "Previous (←)", this.at - 1))
          .child(SMALL(div()).flex_none().min_w(34).text_center().text_color(t.muted)
            .child(`${this.at + 1} / ${n}`))
          .child(arrow("rp-next", "▶", "Next (→)", this.at + 1)))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().min_w(0).gap(6).items_center()
            .when(Boolean(f.loot), (el) => el.child(SMALL(div()).flex_none().text_color(t.accent).child("◆ LOOT")))
            .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(f.name)))
          .child(SMALL(div()).truncate().text_color(t.dim).child(short(f.path))))
        .child(button("rp-attach", "Attach to agent", () => { closeOverlay(props().overlay); attach(f.path, pane); }))
        .child(button("rp-open", "Open in default app", () => openFile(f.path)))
        .child(button("rp-reveal", "Show in folder", () => reveal(f.path)))
        .child(button("rp-close", "Close", () => closeOverlay(props().overlay))))
      .child(body);
  }

  // ---- the panel ----

  render(cx) {
    const t = theme();
    if (props()?.preview) return this.preview(t);
    const pick = KINDS.find((k) => k.id === this.kind);
    const match = (f) => this.kind === "all" || (pick.kinds ?? [pick.id]).includes(f.kind);
    const loot = this.lootRows(match);
    const dropped = new Set(loot.map((f) => same(f.path)));
    const list = (this.files ?? []).filter((f) => match(f) && !dropped.has(same(f.path)));
    const steps = [...loot, ...list]; // what the preview window steps through, in this order
    const now = Date.now();
    const badge = (f) => SMALL(div()).w(56).h(40).flex_none().rounded(6).bg(t.raised).flex().items_center().justify_center()
      .text_color(t.dim).child((f.ext || "file").toUpperCase());
    const small = (id, label, tip, act) => SMALL(div())
      .id(id)
      .px(6)
      .h(20)
      .rounded(5)
      .flex()
      .items_center()
      .text_color(t.muted)
      .bg(t.raised)
      .hover((el) => el.text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        act();
      })
      .child(label);
    const row = (f, i) => {
      const tag = f.loot ? "rl" : "rs";
      const isNew = Boolean(f.loot) && now - f.at < FRESH;
      const meta = f.loot
        ? `${ago(f.at)} · ${bytes(f.size)} · ${short(f.dir)}`
        : `${f.dir === "." ? "" : `${f.dir} · `}${ago(f.mtime)} · ${bytes(f.size)}`;
      const tip = [f.path, f.loot ? `Dropped by ${dropper(f.terminal)}` : null, `Click: ${canPreview(f) ? "preview" : "Open in default app"}`];
      return h_flex()
        .id(`${tag}-${i}-${f.mtime}`)
        .mx(6)
        .px(6)
        .py(5)
        .gap(10)
        .rounded(8)
        .items_center()
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = f.path;
          else if (this.hovered === f.path) this.hovered = null;
          cx.notify();
        })
        .tooltip(tip.filter(Boolean).join("\n"))
        .on_click(() => this.open(f, steps))
        .child(f.thumb ? div().w(56).h(40).flex_none().rounded(6).bg(t.raised).child(image(f.thumb).size_full()) : badge(f))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().min_w(0).gap(6).items_center()
            .child(div().min_w(0).truncate().text_color(t.foreground).child(f.name))
            .when(isNew, (el) => el.child(SMALL(div()).flex_none().px(4).rounded(3).bg(t.accent).text_color(t.accent_foreground).child("new"))))
          .child(SMALL(div()).truncate().text_color(t.dim).child(meta)))
        .when(this.hovered === f.path, (el) => el
          .child(small(`${tag}-at-${i}`, "Attach", "Put it in this pane's agent prompt (briefly uses the clipboard)", () => attach(f.path, this.pane)))
          .child(small(`${tag}-fd-${i}`, "Folder", "Show in Explorer", () => reveal(f.path))));
    };
    // A heading inside the list: a pixel mark, a title, a rule to the edge and a note.
    const heading = (id, mark, title, note, tip) => h_flex()
      .id(id)
      .mx(12)
      .mt(6)
      .mb(2)
      .gap(6)
      .items_center()
      .tooltip(tip)
      .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(t.accent).child(mark)))
      .child(div().text_size(11).text_color(t.accent).child(title))
      .child(div().flex_1().h(1).bg(alpha(t.border, "60")))
      .when(Boolean(note), (el) => el.child(SMALL(div()).text_color(t.dim).child(note)));
    const say = (text) => div().px(14).py(8).text_size(12).text_color(t.dim).child(text);
    const fresh = loot.filter((f) => now - f.at < FRESH).length;

    const icon = (id, path, tip, on, act) => div()
      .id(id)
      .text_color(on ? t.accent : t.dim)
      .hover((el) => el.text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => act(cx))
      .child(svg(path).size(13));
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(12.5)
      .child(h_flex().px(14).h(40).flex_none().gap(10).items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Results"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(short(this.folder)))
        .child(icon("rs-pin", this.locked ? "mods/workspace-chrome/pin-off.svg" : "mods/workspace-chrome/pin.svg",
          this.locked ? "Unpin the folder (follow the focused pane)" : "Pin this folder", this.locked, (cx) => { this.locked = !this.locked; cx.notify(); }))
        .child(icon("rs-folder", "mods/workspace-chrome/folder.svg", "Open the folder in Explorer", false, () => this.folder && openFile(this.folder)))
        .child(this.busy
          ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
          : icon("rs-refresh", "mods/claude-sessions/refresh.svg", "Refresh", false, (cx) => this.refresh(cx, true)))
        .child(icon("rs-close", "mods/workspace-chrome/x.svg", "Close the panel (Ctrl+Shift+R)", false, () => run("layout.hide", { id: "results" }))))
      .child(h_flex().px(12).pb(6).gap(4).flex_none()
        .children(KINDS.map((k) => div()
          .id(`rs-k-${k.id}`)
          .px(8)
          .h(22)
          .rounded(6)
          .flex()
          .items_center()
          .text_size(11)
          .cursor_pointer()
          .bg(this.kind === k.id ? t.selected : t.chrome)
          .text_color(this.kind === k.id ? t.foreground : t.dim)
          .hover((el) => el.text_color(t.foreground))
          .on_click((_e, cx) => { this.kind = k.id; cx.notify(); })
          .child(k.label))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(4).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("rs-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        .when(loot.length > 0, (el) => el
          .child(heading("rs-loot-head", "◆", "LOOT DROPPED", fresh ? `${fresh} new` : `${loot.length}`,
            "Files the agents in this tab made, wherever they saved them"))
          .children(loot.map(row))
          .child(heading("rs-here-head", null, "IN THIS FOLDER", null, short(this.folder) || "The focused pane's folder")))
        .when(!this.folder, (el) => el.child(say("Click a terminal pane to show its folder.")))
        .when(this.files !== null && !list.length, (el) => el.child(say("No recent results in this folder.")))
        .children(list.map(row)));
  }
}
