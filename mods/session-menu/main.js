// The right-click menu and the questions the Claude and Codex session panels open. Props are
// {menu: {title, groups: [{label, items: [{label, note, action}]}]}} or
// {confirm: {heading, body, hint, actions: [{label, primary, action}]}}.
// An action is data, so it travels in props:
//   {tab: tab.new args}               open it
//   {focus: pane}                      go to the tab that has the session open
//   {confirm: …}                       ask first, in a dialog
//   {toCodex: {path, cwd, title, perm, account, home}}   hand a Claude session to its Codex pair
//   {toClaude: {thread, bypass, account}}                hand a Codex thread to its Claude pair
//                 (bridge.py: the first move makes the pair, later ones reopen it with what's new)
//   {hide: {key, id, hidden}}          hide it from its panel, or show it again (a shared list)
//   {resetPass: {account}}             spend one Codex "Full reset" pass (after a confirm), then refresh the gauges

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, theme, props, openOverlay, closeOverlay, notify, appHome, shared, setShared } from "herdr";

// Codex under another account reads this account's threads from its databases.
function codexArgv(account, home, thread, verb = "resume", model = null) {
  const argv = [account.cmd, verb, thread];
  if (!account.main) argv.push("-c", `sqlite_home=${home.replace(/\\/g, "/")}`);
  if (model) argv.push("-m", model);
  return argv;
}

const PY = ["-X", "utf8"];

export default class SessionMenu extends View {
  init() {
    this.busy = null;
  }

  done() {
    closeOverlay(props().overlay);
  }

  act(action, cx) {
    if (!action) return this.done();
    if (action.tab) {
      this.done();
      return run("tab.new", action.tab);
    }
    if (action.focus) {
      this.done();
      return run("pane.focus", { pane: action.focus });
    }
    if (action.hide) {
      const { key, id, hidden } = action.hide;
      const ids = new Set(shared(key) ?? []);
      hidden ? ids.add(id) : ids.delete(id);
      setShared(key, [...ids]);
      return this.done();
    }
    if (action.confirm) {
      this.done();
      const rows = Math.ceil((action.confirm.body.length + action.confirm.hint.length) / 46);
      return openOverlay({ mod: "session-menu", kind: "dialog", width: 420, height: 150 + rows * 19, props: { confirm: action.confirm } });
    }
    if (action.toCodex) return this.work(cx, "Codex로 넘기는 중…", "옮기지 못했어요", async () => ({ tab: await this.toCodex(action.toCodex) }));
    if (action.toClaude) return this.work(cx, "Claude로 넘길 기록을 정리하는 중…", "옮기지 못했어요", async () => ({ tab: await this.toClaude(action.toClaude) }));
    if (action.resetPass) return this.work(cx, "한도 초기화권을 쓰는 중…", "초기화권을 쓰지 못했어요", () => this.resetPass(action.resetPass));
  }

  // Shows what's happening, then closes. The job returns what to do next: open a tab, say
  // something, or tell another mod (`<mod>.<command>`). A failure becomes a notification.
  work(cx, label, failure, job) {
    if (this.busy) return;
    this.busy = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const next = await job();
        if (next?.tab) run("tab.new", next.tab);
        if (next?.notice) notify(next.notice);
        if (next?.command) run(next.command);
      } catch (e) {
        notify({ title: failure, body: String(e?.message ?? e), level: "error", timeout: 12000 });
      }
      this.done();
    });
  }

  async resetPass({ account }) {
    const r = await this.python("usage-gauge/reset.py", [account]);
    const said = {
      reset: { title: `${account} 한도를 초기화했어요`, body: `남은 초기화권: ${r.left}개`, level: "success" },
      nothingToReset: { title: "초기화할 사용량이 없었어요", body: "초기화권은 쓰이지 않았어요.", level: "info" },
      noCredit: { title: "남은 초기화권이 없어요", body: account, level: "warning" },
      alreadyRedeemed: { title: "이미 쓴 초기화권이에요", body: "게이지를 다시 읽어 확인해 주세요.", level: "warning" },
    }[r.outcome] ?? { title: `결과: ${r.outcome}`, level: "info" };
    return { notice: { ...said, timeout: 10000 }, command: "usage-gauge.refresh" };
  }

  async python(script, args) {
    const r = await exec("python", [...PY, `${appHome()}/mods/${script}`, ...args]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `${script} exited with ${r.code}`);
    return JSON.parse(r.stdout);
  }

  // The pair's Codex thread (made by Codex's own importer the first time), with what Claude did
  // since the last move as its first message.
  async toCodex({ path, cwd, title, perm, account, home }) {
    const r = await this.python("session-menu/bridge.py", ["to-codex", path, cwd, title]);
    const argv = codexArgv(account, home, r.thread, "resume", account.main ? null : account.best);
    if (r.prompt) argv.splice(3, 0, r.prompt);
    if (perm === "bypassPermissions") argv.push("-s", "danger-full-access", "-a", "never");
    return { name: `${r.title} · ${account.name}`, folder: r.cwd, argv };
  }

  // The pair's Claude session (a new one with a fixed id the first time), with what Codex did
  // since the last move as its first message.
  async toClaude({ thread, bypass, account }) {
    const r = await this.python("session-menu/bridge.py", ["to-claude", thread, account.config]);
    const argv = r.mode === "new" ? [account.cmd, "--session-id", r.session] : [account.cmd, "--resume", r.path];
    if (bypass) argv.push("--dangerously-skip-permissions");
    if (r.prompt) argv.push(r.prompt);
    return { name: `${r.title} · ${account.name}`, folder: r.cwd, argv };
  }

  menu(t, m) {
    if (this.busy) {
      return h_flex().size_full().p(14).gap(10).items_center().bg(t.popover).text_size(12.8).text_color(t.muted)
        .child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.working).spin(900))
        .child(div().child(this.busy));
    }
    const row = (item, id) => h_flex()
      .id(id)
      .h(32)
      .px(8)
      .gap(8)
      .rounded(7)
      .items_center()
      .cursor_pointer()
      .text_color(t.foreground)
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => this.act(item.action, cx))
      .child(div().flex_none().font_medium().child(item.label))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(item.note ?? ""));
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim).truncate().child(m.title))
      .children(m.groups.flatMap((g, gi) => [
        div().px(8).pt(8).pb(2).text_size(11).font_medium().text_color(t.muted).child(g.label),
        ...g.items.map((item, ii) => row(item, `sm-${gi}-${ii}`)),
      ]));
  }

  confirm(t, c) {
    const button = (a, i) => div()
      .id(`sm-c-${i}`)
      .h(30)
      .px(12)
      .rounded(7)
      .flex()
      .items_center()
      .text_size(12.5)
      .font_medium()
      .cursor_pointer()
      .bg(a.primary ? t.solid : t.raised)
      .text_color(a.primary ? t.solid_foreground : t.foreground)
      .when(!a.primary, (el) => el.hover((el) => el.bg(t.hover)))
      .on_click((_e, cx) => this.act(a.action, cx))
      .child(a.label);
    return v_flex()
      .size_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(div().font_semibold().child(c.heading))
      .child(div().text_color(t.muted).child(c.body))
      .child(div().text_size(12).text_color(t.dim).child(c.hint))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end().children(c.actions.map(button)));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    if (p.confirm) return this.confirm(t, p.confirm);
    if (p.menu) return this.menu(t, p.menu);
    return div();
  }
}
