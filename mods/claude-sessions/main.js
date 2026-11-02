// Claude desktop app sessions, newest first. A click resumes one in a new tab with the app's
// own model, effort and permission mode; a right click offers the other accounts and Codex.
// One the app still runs asks first.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, terminals, agents, run, theme, notify, appHome, layout, openOverlay, shared, setShared, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as the agents list reads it.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const DAY = 86400000;
function group(ms, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (ms >= start) return "오늘";
  if (ms >= start - DAY) return "어제";
  if (ms >= start - 6 * DAY) return "지난 7일";
  if (ms >= start - 29 * DAY) return "지난 30일";
  return "그 이전";
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간` : `${Math.floor(h / 24)}일`;
}

// Any account resumes the transcript by its path and writes on there (a session made by a move
// from Codex may live in another account's folder).
function argvFor(s, account, fork) {
  const argv = [account.cmd, "--resume", s.path];
  if (fork) argv.push("--fork-session");
  if (s.model) argv.push("--model", s.model);
  if (s.effort) argv.push("--effort", s.effort);
  if (s.perm === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else if (s.perm && s.perm !== "default") argv.push("--permission-mode", s.perm);
  return argv;
}

// A tab started here runs `& 'claude' '--resume' '<id or path>' ...` in its shell, so the id finds it.
const terminalFor = (s, all) =>
  all.find((k) => k.state === "live" && k.labels?.["herdr.space"] && (k.argv ?? []).some((a) => String(a).includes(s.cli)));

const MAIN = { name: "claude", cmd: "claude", main: true };

// Sessions hidden from the list (ids, kept in shared state; the menu adds and removes them).
const HIDDEN = "sessions.hidden.claude";
const HIDDEN_GROUP = "숨김";
const REQUEST = "sessions.request.claude";

// Idle: a ring; working: the spinner; blocked and done: a dot in their color; not open: room only.
function dot(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).when(Boolean(t[status]), (el) => el.bg(t[status]));
}

export default class ClaudeSessions extends View {
  init(_props, cx) {
    this.sessions = null;
    this.accounts = [MAIN];
    this.error = null;
    this.busy = false;
    this.spin = true;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.refresh(cx);
    cx.timer.every(60000, (cx) => this.refresh(cx));
    // The session-search window hands its pick here, to open as if clicked in this list.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const req = shared(REQUEST);
        if (!String(command).endsWith("request") || !req) continue;
        setShared(REQUEST, null);
        const s = (this.sessions ?? []).find((x) => x.cli === req.id);
        if (s) req.what === "menu" ? this.menu(s) : this.open(s);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/claude-sessions/list.ps1`]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `list.ps1 exited with ${r.code}`);
        const data = JSON.parse(r.stdout);
        this.sessions = data.sessions.filter((s) => !s.archived);
        this.accounts = data.accounts?.length ? data.accounts : [MAIN];
        // The Codex panel's menu offers these accounts too.
        if (JSON.stringify(shared("sessions.claude")?.accounts) !== JSON.stringify(this.accounts)) setShared("sessions.claude", { accounts: this.accounts });
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.spin = false;
      cx.notify();
    });
  }

  fold(label) {
    this.folded.has(label) ? this.folded.delete(label) : this.folded.add(label);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
  }

  // What opening the session with an account does: go to its tab, ask first, or open it.
  action(s, account) {
    const k = terminalFor(s, terminals());
    const a = k && agents().find((a) => a.address === k.address);
    if (a) return { focus: a.pane };
    if (!s.resumable) return { problem: "이 PC에 대화 기록(.jsonl)이 없어요." };
    if (!s.folder) return { problem: `작업 폴더가 없어요: ${s.cwd ?? ""}` };
    const name = account.main ? s.title : `${s.title} · ${account.name}`;
    const tab = { name, folder: s.cwd, argv: argvFor(s, account, false) };
    if (!s.desktop) return { tab };
    return {
      confirm: {
        heading: "데스크톱 앱에서도 열려 있는 세션",
        body: `‘${s.title}’ 세션이 Claude 데스크톱 앱에서도 열려 있어요. 두 곳에서 번갈아 입력하면 대화 기록이 갈라집니다.`,
        hint: "이어가기: 데스크톱 쪽에서는 더 입력하지 마세요. 복사본: 새 세션으로 갈라져 나와 서로 영향이 없어요.",
        actions: [
          { label: "취소", action: null },
          { label: "복사본으로 열기", action: { tab: { name: `${name} (복사본)`, folder: s.cwd, argv: argvFor(s, account, true) } } },
          { label: `${account.name}로 이어가기`, primary: true, action: { tab } },
        ],
      },
    };
  }

  // The panel does the simple ones itself; a question goes to the session-menu dialog.
  perform(action) {
    if (action.problem) return notify({ title: "이 세션은 열 수 없어요", body: action.problem, level: "warning" });
    if (action.focus) return run("pane.focus", { pane: action.focus });
    if (action.tab) return run("tab.new", action.tab);
    openOverlay({ mod: "session-menu", kind: "dialog", width: 420, height: 236, props: { confirm: action.confirm } });
  }

  open(s) {
    this.perform(this.action(s, this.accounts.find((a) => a.main) ?? MAIN));
  }

  menu(s) {
    const usable = (action) => (action.problem ? null : action);
    const mail = (a) => a.email || "";
    const groups = [{
      label: "Claude 계정으로 이어가기",
      items: this.accounts.map((a) => ({ label: a.name, note: mail(a), action: usable(this.action(s, a)) })),
    }];
    const hidden = (shared(HIDDEN) ?? []).includes(s.cli);
    const codex = shared("sessions.codex");
    if (s.resumable && s.folder && codex?.accounts?.length) {
      groups.push({
        label: s.link ? "Codex로 넘기기 · 짝 작업에 이어서" : "Codex로 넘기기 · 새 작업으로",
        items: codex.accounts.map((c) => ({
          label: c.name,
          note: c.main ? mail(c) : `${mail(c)} · ${c.best ?? ""}`,
          action: { toCodex: { path: s.path, cwd: s.cwd, title: s.title, perm: s.perm, account: c, home: codex.home } },
        })),
      });
    }
    groups.push({
      label: "목록",
      items: [hidden
        ? { label: "다시 보이기", note: "숨김에서 꺼내 원래 자리로", action: { hide: { key: HIDDEN, id: s.cli, hidden: false } } }
        : { label: "패널에서 숨기기", note: "아래 '숨김'에 모아 둬요", action: { hide: { key: HIDDEN, id: s.cli, hidden: true } } }],
    });
    const rows = groups.reduce((n, g) => n + g.items.length, 0);
    openOverlay({ mod: "session-menu", kind: "popup", width: 300, height: 40 + groups.length * 26 + rows * 32, props: { menu: { title: s.title, groups } } });
  }

  render(cx) {
    const t = theme();
    const rail = narrow();
    const now = Date.now();
    const all = terminals();
    const live = new Map(agents().map((a) => [a.address, a]));
    const hiddenIds = new Set(shared(HIDDEN) ?? []);
    const list = (this.sessions ?? []).filter((s) => !hiddenIds.has(s.cli));
    const hidden = (this.sessions ?? []).filter((s) => hiddenIds.has(s.cli));

    const row = (s) => {
      const k = terminalFor(s, all);
      const a = k && live.get(k.address);
      const off = !s.resumable || !s.folder;
      const tip = [s.cwd, s.origin === "herdr" ? "Codex에서 넘겨받아 herdr에서 만든 세션" : `${s.turns ?? 0}턴 · ${s.model ?? ""} · ${s.effort ?? ""}`,
        s.link ? `⇄ Codex 작업 «${s.link.title}»과 짝: 오갈 때 양쪽 세션에 이어서 쌓여요` : null,
        s.desktop ? "데스크톱 앱에서 열려 있음" : null, a ? "herdr 탭에서 열려 있음" : null, "오른쪽 클릭: 다른 계정·Codex로 열기"]
        .filter(Boolean)
        .join("\n");
      const right = (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(s);
      });
      if (rail) {
        return right(h_flex()
          .id(`cs-${s.cli}`)
          .h(26)
          .flex_none()
          .items_center()
          .justify_center()
          .hover((el) => el.bg(t.hover))
          .tooltip(`${s.title}\n${tip}`)
          .on_click(() => this.open(s))
          .child(dot(t, a?.status)));
      }
      return right(h_flex()
        .id(`cs-${s.cli}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(8)
        .when(Boolean(a?.focused), (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(tip)
        .on_click(() => this.open(s))
        .child(dot(t, a?.status))
        .child(div().flex_1().min_w(0).truncate().text_color(off ? t.dim : t.foreground).child(s.title || "(제목 없음)"))
        .when(Boolean(s.link), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("⇄")))
        .when(s.desktop, (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).flex().items_center().child("앱")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - (s.last ?? 0)))));
    };

    // Date groups in list order; a header folds its group and, folded, says how many.
    const groups = [];
    for (const s of list) {
      const label = group(s.last ?? 0, now);
      if (groups.at(-1)?.label === label) groups.at(-1).members.push(s);
      else groups.push({ label, members: [s] });
    }
    if (hidden.length) groups.push({ label: HIDDEN_GROUP, members: hidden });
    // The hidden group starts folded; the others start open.
    const isFolded = (label) => (label === HIDDEN_GROUP ? !this.folded.has(`${HIDDEN_GROUP}:open`) : this.folded.has(label));
    const header = (g, i) => {
      const open = !isFolded(g.label);
      return h_flex()
        .id(`cs-group-${i}`)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .text_color(t.dim)
        .cursor_pointer()
        .hover((el) => el.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.fold(g.label === HIDDEN_GROUP ? `${HIDDEN_GROUP}:open` : g.label);
          cx.notify();
        })
        .child(div().truncate().child(g.label))
        .when(!open, (el) => el.child(div().child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none()));
    };
    const rows = rail ? list.map(row) : groups.flatMap((g, i) => [header(g, i), ...(isFolded(g.label) ? [] : g.members.map(row))]);

    const note = (text, color) => div().px(16).py(4).text_size(12).text_color(color).child(text);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!rail, (el) => el
        .child(h_flex()
          .px(16)
          .h(41)
          .pt(14)
          .pb(5)
          .flex_none()
          .items_center()
          .justify_between()
          .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Claude 세션"))
          .child(div()
            .id("cs-search")
            .mr(10)
            .text_color(t.dim)
            .hover((el) => el.text_color(t.foreground))
            .tooltip("세션 찾기 (Ctrl+Shift+S)")
            .on_click(() => {
              setShared("sessions.search.kind", "claude");
              run("mod.open", { name: "session-search" });
            })
            .child(svg("mods/workspace-chrome/search.svg").size(13)))
          .child(this.spin
            ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.dim).spin(900)
            : div()
              .id("cs-refresh")
              .text_color(t.dim)
              .hover((el) => el.text_color(t.foreground))
              .tooltip("다시 읽기")
              .on_click((_e, cx) => {
                this.spin = true;
                this.refresh(cx);
                cx.notify();
              })
              .child(svg("mods/claude-sessions/refresh.svg").size(13))))
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)))
        .when(this.sessions?.length === 0, (el) => el.child(note("데스크톱 앱 세션이 없어요.", t.dim))))
      .child(v_flex().id("cs-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
