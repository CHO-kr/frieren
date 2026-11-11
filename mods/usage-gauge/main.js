// Plan usage of every Claude and Codex account, as small gauges in the top bar. A Claude account
// shows its weekly limit; a Codex account its plan's windows (fullest percent, a thin bar each).
// Hovering tells every window and when it resets, a click reads again. usage.py reads, every 5 minutes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, appHome, home, readTextFile, shared, setShared, nextCommand, openOverlay, notify, run, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Each account's weekly use and real login, for the pane headers (shared "usage.accounts").
function share(data) {
  const brief = {};
  for (const a of data?.accounts ?? []) {
    const weekly = (a.windows ?? []).find((w) => w.label === "weekly") ?? (a.windows ?? []).at(-1);
    brief[a.name] = { used: weekly?.used ?? null, window: weekly?.label ?? null, login: a.login || a.email || null, warning: a.warning ?? null };
  }
  if (JSON.stringify(shared("usage.accounts")) !== JSON.stringify(brief)) setShared("usage.accounts", brief);
}

const CACHE = () => `${home()}/AppData/Local/herdr-sessions/usage.json`;

function until(ms, now) {
  const m = Math.max(0, Math.round((ms - now) / 60000));
  if (m < 60) return `in ${m}m`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 43011.06 → "43.0k"; the exact number is in the tooltip.
function compact(n) {
  if (n == null) return "";
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n >= 1000 ? `${(n / 1000).toFixed(2)}k` : String(Math.round(n));
}

function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default class UsageGauge extends View {
  init(_props, cx) {
    this.data = null;
    this.busy = false;
    cx.spawn(async (cx) => {
      // The last reading first, so the bar isn't empty while the new one comes in.
      try {
        const text = await readTextFile(CACHE());
        if (text && !this.data) {
          this.data = JSON.parse(text);
          share(this.data);
        }
      } catch {}
      cx.notify();
      this.refresh(cx);
    });
    cx.timer.every(5 * 60000, (cx) => this.refresh(cx));
    // "usage-gauge.refresh": read now (after a reset pass is spent).
    cx.spawn(async (cx) => {
      for (;;) {
        if (String(await nextCommand()).endsWith("refresh")) this.refresh(cx);
      }
    });
  }

  // A right click on a Codex chip offers its reset pass, behind a confirm.
  askReset(a, windows) {
    const count = a.resets?.count ?? 0;
    if (!count) return notify({ title: "No reset passes left", body: a.name, level: "info" });
    const w = windows[0];
    const used = w?.used ?? 0;
    openOverlay({
      mod: "session-menu", kind: "dialog", width: 440, height: 250, props: {
        confirm: {
          heading: `Use a reset pass on ${a.name}?`,
          body: `Spends the soonest-expiring of your ${count} reset passes to set ${w?.label ?? ""} usage (${used}%) back to 0%.`,
          hint: `A spent pass can't be undone.${used < 70 ? ` At ${used}% it may be worth saving.` : ""}`,
          actions: [
            { label: "Cancel", action: null },
            { label: "Use reset pass", primary: true, action: { resetPass: { account: a.name } } },
          ],
        },
      },
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python", ["-X", "utf8", `${appHome()}/mods/usage-gauge/usage.py`]);
        if (r.code === 0) {
          this.data = JSON.parse(r.stdout);
          share(this.data);
        }
      } catch {}
      this.busy = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const level = (used) => (used >= 90 ? t.blocked : used >= 70 ? t.working : t.done);
    const bar = (w, span) => div().w_full().h(3).rounded(2).bg(t.raised)
      .child(div().h_full().rounded(2).w(Math.max(2, Math.round(span * Math.min(100, w.used ?? 0) / 100))).bg(w.used == null ? t.dim : level(w.used)));

    const chip = (a) => {
      // A failed read keeps the last numbers, but a window that has reset since then no longer
      // has that use: it shows as unknown (empty bar), not the old percent (codex4 showed 98%
      // for a 5-hour window that had reset hours before, 2026-11-04).
      const expired = (w) => a.stale && w.resets != null && w.resets <= now;
      const all = (a.windows ?? []).map((w) => (expired(w) ? { ...w, used: null, was: w.used } : w));
      // Claude shows its weekly limit only (the 5-hour one stays in the tooltip); Codex shows what its plan has.
      const weekly = all.filter((w) => w.label === "weekly");
      const windows = a.agent === "claude" && weekly.length ? weekly : all;
      const known = windows.filter((w) => w.used != null);
      const top = known.reduce((m, w) => Math.max(m, w.used), 0);
      const tip = [
        `${a.name}${a.login || a.email ? ` · ${a.login || a.email}` : ""}${a.plan ? ` (${a.plan})` : ""}`,
        a.warning ? `⚠ ${a.warning}` : null,
        a.credits ? `Credits: ${a.credits.unlimited ? "unlimited" : a.credits.balance != null ? Math.round(a.credits.balance).toLocaleString() : "none"}` : null,
        a.resets?.count ? `Reset passes: ${a.resets.count}${a.resets.expires ? ` (first expires ${until(a.resets.expires, now)})` : ""}` : null,
        ...[...windows, ...all.filter((w) => !windows.includes(w))].map((w) => w.used == null
          ? `${w.label}: unknown (reset since the last reading, ${w.was}%)`
          : `${w.label}: ${w.used}%${w.resets ? ` · resets ${until(w.resets, now)}` : ""}`),
        a.error ? `Couldn't read: ${a.error}` : null,
        a.checked ? `Checked: ${ago(a.checked, now)}${a.stale ? " (old value)" : ""}` : null,
        "Click: refresh",
        a.resets?.count ? "Right-click: use a reset pass (asks first)" : null,
      ].filter(Boolean).join("\n");
      // A Codex chip also says, beside its bar, its credits left and free reset passes ("43.0k ↺2").
      const money = a.credits ? `${a.credits.unlimited ? "∞" : compact(a.credits.balance)}${a.resets?.count ? ` ↺${a.resets.count}` : ""}` : null;
      const width = money ? 104 : 78;
      return v_flex()
        .id(`ug-${a.agent}-${a.name}`)
        .w(width)
        .h(32)
        .px(6)
        .gap(3)
        .justify_center()
        .rounded(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        // A press here is a click, not a window drag.
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.refresh(cx))
        .when(a.agent === "codex", (el) => el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.askReset(a, windows);
        }))
        .tooltip(tip)
        .child(h_flex()
          .justify_between()
          .text_size(10.5)
          .child(div().truncate().text_color(a.warning ? t.working : a.stale ? t.dim : t.muted).child(a.warning ? `${a.name}!` : a.name))
          .child(a.login_needed
            ? div().font_medium().text_color(t.working).child("login")
            : div().font_medium().text_color(known.length ? (a.stale ? t.dim : level(top)) : t.dim).child(known.length ? `${top}%` : a.retry_at ? "wait" : "—")))
        .when(!money, (el) => el.children(windows.slice(0, 2).map((w) => bar(w, width - 12))))
        .when(Boolean(money), (el) => el.child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).children(windows.slice(0, 1).map((w) => bar(w, 44))))
          .child(div().flex_none().text_size(9.5).text_color(a.stale ? t.dim : t.muted).child(money))));
    };

    const accounts = this.data?.accounts ?? [];
    // No "Claude"/"Codex" heading: the chip names (claude2, codex3) already say which (user request 2026-11-02).
    const group = (agent) => {
      const mine = accounts.filter((a) => a.agent === agent);
      if (!mine.length) return null;
      return h_flex().gap(2).items_center().children(mine.map(chip));
    };
    // The results panel's button (Ctrl+Shift+R does the same); lit while the panel is open.
    const results = find(layout(), "results");
    const open = results && results.hidden !== true;
    const resultsButton = results && div()
      .id("ug-results")
      .ml(4)
      .h(26)
      .px(9)
      .gap(5)
      .rounded(7)
      .flex()
      .items_center()
      .text_size(11.5)
      .cursor_pointer()
      .bg(open ? t.selected : t.raised)
      .text_color(open ? t.foreground : t.muted)
      .hover((el) => el.text_color(t.foreground))
      .tooltip(open ? "Close the results panel (Ctrl+Shift+R)" : "Open the results panel (Ctrl+Shift+R)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("layout.toggle", { id: "results" }))
      .child(svg("mods/workspace-chrome/files.svg").size(13))
      .child("Results");
    return h_flex()
      .size_full()
      .px(10)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .when(!accounts.length, (el) => el.child(div().text_size(11).text_color(t.dim).child(this.busy ? "Reading usage…" : "No usage data")))
      .children([group("claude"), group("codex")].filter(Boolean))
      .when(Boolean(resultsButton), (el) => el.child(resultsButton));
  }
}
