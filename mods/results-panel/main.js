// Results: the newest files in the focused terminal's folder (images, video, sound, documents,
// code), with thumbnails. A click shows an image, Markdown or text in a preview window and opens
// anything else in its default app; "첨부" puts the file into the agent's prompt as if dropped
// there. Toggle with Ctrl+Shift+R. recent.py lists the files and makes the small pictures.
// The same mod draws the preview window (props.preview).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { exec, focused, run, theme, settings, notify, appHome, home, layout, readTextFile, watchFolder, openOverlay, closeOverlay, props } from "herdr";

const KINDS = [
  { id: "all", label: "전체" },
  { id: "image", label: "이미지" },
  { id: "media", label: "영상·소리", kinds: ["video", "audio"] },
  { id: "doc", label: "문서" },
  { id: "code", label: "코드" },
];
const TEXT = new Set(["md", "txt", "json", "csv", "srt", "vtt", "log", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "css", "sh", "bat", "cmd", "toml", "yaml", "yml", "xml"]);
const LANG = { ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", ps1: "bash", sh: "bash" };

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
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
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
  if (!pane) return notify({ title: "첨부할 칸이 없어요", body: "에이전트가 있는 칸을 한 번 누른 뒤 다시 해 주세요.", level: "info" });
  await exec("powershell", ["-NoProfile", "-Command", "& { param($p) Set-Clipboard -LiteralPath $p }", path]);
  run("pane.focus", { pane });
  run("terminal.paste");
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
    this.follow(cx);
    // Focus moves without telling a mod in a block, so look now and then (cheap: no programs run).
    cx.timer.every(1500, (cx) => this.follow(cx));
    // The home folder has too much going on to watch; it is read again every minute while shown.
    cx.timer.every(60000, (cx) => {
      if (shown() && this.folder && this.isHome()) this.refresh(cx);
    });
  }

  isHome() {
    return this.folder?.toLowerCase() === home().toLowerCase();
  }

  // Follows the focused terminal's folder (unless pinned) and remembers its pane for "첨부".
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
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/results-panel/recent.py`, folder, "80"]);
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

  open(f) {
    if (f.kind === "image" || TEXT.has(f.ext)) {
      return openOverlay({ mod: "results-panel", kind: "window", key: "result-preview", width: 0.62, height: 0.78, props: { preview: f, pane: this.pane } });
    }
    openFile(f.path);
  }

  // ---- the preview window ----

  initPreview(cx) {
    const f = props().preview;
    this.handle = cx.focus_handle();
    this.picture = null;
    this.text = null;
    this.code = null;
    cx.spawn(async (cx) => {
      try {
        if (f.kind === "image") {
          const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/results-panel/recent.py`, "--preview", f.path]);
          if (r.code === 0) this.picture = JSON.parse(r.stdout).image;
          else this.problem = "이미지를 열지 못했어요.";
        } else {
          const text = await readTextFile(f.path);
          if (text === null) this.problem = "파일이 없어졌어요.";
          else if (f.ext === "md") this.text = text;
          else {
            const t = theme();
            this.code = EditorState.new({ language: LANG[f.ext] ?? f.ext, readonly: true, value: text, font_family: settings().font_family, font_size: 12,
              syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
          }
        }
      } catch {
        this.problem = "미리 볼 수 없는 파일이에요 (너무 크거나 읽을 수 없음). 기본 앱으로 열어 보세요.";
      }
      cx.notify();
    });
  }

  preview(t) {
    const f = props().preview;
    const pane = props().pane;
    const button = (id, label, act) => div()
      .id(id)
      .h(26)
      .px(10)
      .rounded(6)
      .flex()
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .bg(t.raised)
      .text_color(t.foreground)
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(act)
      .child(label);
    const body = this.problem
      ? div().p(16).text_color(t.dim).child(this.problem)
      : this.picture
        ? div().flex_1().min_h(0).p(10).flex().items_center().justify_center().child(image(this.picture).size_full())
        : this.text !== null
          ? div().flex_1().min_h(0).px(18).py(10).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(TextView.markdown(`md-${f.path}`, this.text).selectable(true).scrollable(true).size_full())
          : this.code
            ? div().flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Editor.new(this.code).size_full())
            : div().p(16).text_color(t.dim).child("여는 중…");
    return v_flex()
      .id("result-preview")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().font_medium().text_color(t.foreground).child(f.name))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(short(f.path))))
        .child(button("rp-attach", "에이전트에 첨부", () => { closeOverlay(props().overlay); attach(f.path, pane); }))
        .child(button("rp-open", "기본 앱으로 열기", () => openFile(f.path)))
        .child(button("rp-reveal", "폴더에서 보기", () => reveal(f.path)))
        .child(button("rp-close", "닫기", () => closeOverlay(props().overlay))))
      .child(body);
  }

  // ---- the panel ----

  render(cx) {
    const t = theme();
    if (props()?.preview) return this.preview(t);
    const pick = KINDS.find((k) => k.id === this.kind);
    const list = (this.files ?? []).filter((f) => this.kind === "all" || (pick.kinds ?? [pick.id]).includes(f.kind));
    const badge = (f) => div().w(56).h(40).flex_none().rounded(6).bg(t.raised).flex().items_center().justify_center()
      .text_size(10.5).font_medium().text_color(t.dim).child(f.ext.toUpperCase());
    const small = (id, label, tip, act) => div()
      .id(id)
      .px(6)
      .h(20)
      .rounded(5)
      .flex()
      .items_center()
      .text_size(10.5)
      .text_color(t.muted)
      .bg(t.raised)
      .hover((el) => el.text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        act();
      })
      .child(label);
    const row = (f, i) => h_flex()
      .id(`rs-${i}-${f.mtime}`)
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
      .tooltip(`${f.path}\n클릭: ${f.kind === "image" || TEXT.has(f.ext) ? "미리보기" : "기본 앱으로 열기"}`)
      .on_click(() => this.open(f))
      .child(f.thumb ? div().w(56).h(40).flex_none().rounded(6).bg(t.raised).child(image(f.thumb).size_full()) : badge(f))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(f.name))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${f.dir === "." ? "" : `${f.dir} · `}${ago(f.mtime)} · ${bytes(f.size)}`)))
      .when(this.hovered === f.path, (el) => el
        .child(small(`rs-at-${i}`, "첨부", "지금 칸의 에이전트 입력창에 넣기 (클립보드를 잠깐 써요)", () => attach(f.path, this.pane)))
        .child(small(`rs-fd-${i}`, "폴더", "탐색기에서 보기", () => reveal(f.path))));

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
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("결과물"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(short(this.folder)))
        .child(icon("rs-pin", this.locked ? "mods/workspace-chrome/pin-off.svg" : "mods/workspace-chrome/pin.svg",
          this.locked ? "폴더 고정 풀기 (지금 칸을 따라가요)" : "이 폴더에 고정", this.locked, (cx) => { this.locked = !this.locked; cx.notify(); }))
        .child(icon("rs-folder", "mods/workspace-chrome/folder.svg", "폴더를 탐색기로 열기", false, () => this.folder && openFile(this.folder)))
        .child(this.busy
          ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
          : icon("rs-refresh", "mods/claude-sessions/refresh.svg", "다시 읽기", false, (cx) => this.refresh(cx, true)))
        .child(icon("rs-close", "mods/workspace-chrome/x.svg", "패널 닫기 (Ctrl+Shift+R)", false, () => run("layout.hide", { id: "results" }))))
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
      .when(!this.folder, (el) => el.child(div().px(14).py(8).text_size(12).text_color(t.dim).child("터미널 칸을 한 번 누르면 그 칸의 폴더를 보여 줘요.")))
      .when(this.files !== null && !list.length, (el) => el.child(div().px(14).py(8).text_size(12).text_color(t.dim).child("이 폴더에는 최근 결과물이 없어요.")))
      .child(v_flex().id("rs-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(list.map(row)));
  }
}
