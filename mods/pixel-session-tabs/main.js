// Pixel session tabs: the tab strip over the sidebar's session lists in the Frieren pixel layout.
// The layout puts the three session panels (herdr-sessions, claude-sessions, codex-sessions) in one
// "stack" node and names this mod its header: one tab per panel, in the stack's order. A click shows
// that panel (layout.select). Herdr keeps the pick with the layout's clicks, so it survives restarts,
// and the panels it hides stay alive (lists, timers), so switching back is instant. The stack node
// carries the block's frame and gradient, so this strip draws no panel of its own: it sits inside
// the frame like the PARTY and SPACES headers, and the shown panel's top line is its divider.
//
// The numbers: each panel shares which terminals run its sessions in a Herdr tab, as
// shared("sessions.open.<kind>") = { terminals: [address], listed: n } (sessions hidden from the
// panel left out). This strip looks those terminals up in agents() and counts them live: red for the
// ones that need you (blocked), the working color for the ones at work, a star for the ones that
// finished while nobody was looking. Otherwise no number; the tooltip has the rest.
//
// The session search (Ctrl+Shift+S) hands a pick to the panel that owns it with
// "<panel>-sessions.request", and that reaches shown copies only. So when a pick is for a panel the
// stack hides, the strip shows that panel and hands the pick on again until the panel takes it
// (a panel leaves a pick waiting until its list has loaded).
//
// On a folded sidebar (a rail under 160 px) each tab is the list's icon with a pip for its state.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, layout, theme, run, shared, props } from "herdr";

const ICON = (n) => `mods/pixel-chrome/icons/${n}.svg`;
const alpha = (c, a) => `${String(c ?? "#000000").slice(0, 7)}${a}`;

// The panels this strip knows, by the mod a stack child shows.
const PANELS = {
  "herdr-sessions": { kind: "herdr", label: "Herdr", about: "Claude and Codex sessions started in Herdr tabs", svg: ICON("monitor") },
  "claude-sessions": { kind: "claude", label: "Claude", about: "Claude desktop app sessions", image: "icons/claude.svg" },
  "codex-sessions": { kind: "codex", label: "Codex", about: "Codex app threads", image: "icons/codex.svg" },
};

// How long a session-search pick is still worth handing on.
const PICK_FOR = 15000;

function findNode(node, test) {
  if (!node) return null;
  if (test(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, test);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as the agents list reads it.
const narrow = () => (findNode(layout(), (n) => n.id === "sidebar")?.size?.px ?? Infinity) < 160;

// The stack this strip heads: props().stack when the layout names it, else the first stack with a
// session panel in it.
function sessionStack() {
  const named = props()?.stack;
  return findNode(layout(), (n) => n.type === "stack" && (typeof named === "string" ? n.id === named : (n.children ?? []).some((c) => PANELS[c.content?.mod])));
}

// A list's terminals open in Herdr tabs, as agents() has them now, by status.
function counts(kind, live) {
  const open = shared(`sessions.open.${kind}`);
  const mine = [...new Set(open?.terminals ?? [])].map((address) => live.get(address)).filter(Boolean);
  const by = (status) => mine.filter((a) => a.status === status);
  return { loaded: Boolean(open), listed: open?.listed ?? 0, open: mine, blocked: by("blocked"), working: by("working"), done: by("done") };
}

export default class PixelSessionTabs extends View {
  init() {
    this.width = null;
    this.handed = new Set();
  }

  // A session-search pick: show its panel if the stack hides it, then hand the pick on until the
  // panel takes it (it clears the request), as the panel may only now be starting and loading its
  // list. A shown panel with its list usually takes it at once, and then this does nothing.
  forward(stack, tabs, active, cx) {
    for (const tab of tabs) {
      const key = `sessions.request.${tab.kind}`;
      const req = shared(key);
      if (!req?.at || Date.now() - req.at > PICK_FOR) continue;
      const id = `${tab.kind}:${req.at}`;
      if (this.handed.has(id)) continue;
      if (this.handed.size > 50) this.handed.clear();
      this.handed.add(id);
      const show = tab.child !== active;
      cx.spawn(async (cx) => {
        if (show) run("layout.select", { stack: stack.id, child: tab.child });
        for (let wait = 150; Date.now() - req.at < PICK_FOR; wait = 500) {
          await cx.sleep(wait);
          if (shared(key)?.at !== req.at) return;
          run(`${tab.kind}-sessions.request`);
        }
      });
    }
  }

  render(cx) {
    const t = theme();
    const stack = sessionStack();
    if (!stack) return div().size_full();
    const tabs = (stack.children ?? [])
      .filter((c) => !c.hidden && PANELS[c.content?.mod])
      .map((c) => ({ child: c.id, ...PANELS[c.content.mod] }));
    const active = tabs.find((x) => x.child === stack.active)?.child ?? tabs[0]?.child;
    this.forward(stack, tabs, active, cx);

    const live = new Map(agents().map((a) => [a.address, a]));
    const here = spaces().find((s) => s.active)?.id;
    const rail = narrow();
    const select = (tab) => {
      if (tab.child !== active) run("layout.select", { stack: stack.id, child: tab.child });
    };

    // Who's who in a tooltip: the tab's name, and its space when it isn't the shown one.
    const names = (list) => list.slice(0, 3).map((a) => `${a.tab_name || a.address}${a.space !== here ? ` (${a.space_name})` : ""}`).join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "");
    const tipOf = (tab, c, on) => [
      `${tab.label} · ${tab.about}`,
      c.loaded ? `${c.listed} listed · ${c.open.length} open in a Herdr tab` : "Counts come once this list has loaded",
      c.blocked.length ? `Needs you: ${names(c.blocked)}` : null,
      c.working.length ? `Working: ${names(c.working)}` : null,
      c.done.length ? `Finished, not looked at yet: ${names(c.done)}` : null,
      on ? null : "Click: show this list",
    ].filter(Boolean).join("\n");
    const icon = (tab, size) => (tab.svg ? svg(tab.svg).size(size).flex_none().text_color(t.accent) : image(tab.image).w(size).h(size).flex_none());
    const items = tabs.map((tab) => ({ tab, c: counts(tab.kind, live), on: tab.child === active }));

    // Folded sidebar: an icon per list, underlined when shown, with a pip in the color of its most
    // urgent state.
    if (rail) {
      return h_flex().id("st-root").size_full().px(1).gap(1).items_center()
        .children(items.map(({ tab, c, on }) => {
          const pip = c.blocked.length ? t.blocked : c.working.length ? t.working : c.done.length ? t.done : null;
          return div().id(`st-${tab.child}`).relative().flex_1().min_w(0).h(22).flex().items_center().justify_center()
            .border_b(2).border_color(on ? t.accent : alpha(t.border, "00"))
            .when(on, (el) => el.bg(alpha(t.accent, "1c")))
            .cursor_pointer().hover((el) => el.bg(t.hover))
            .tooltip(tipOf(tab, c, on))
            .on_click(() => select(tab))
            .child(icon(tab, 11))
            .when(Boolean(pip), (el) => el.child(div().absolute().top(1).right(0).size(4).bg(pip)));
        }));
    }

    // A badge: red for needs you, then working, then finished-unseen.
    const badges = (c) => [
      c.blocked.length ? div().flex_none().h(14).min_w(14).px(3).flex().items_center().justify_center().bg(t.blocked)
        .text_color(t.accent_foreground).font_family("Galmuri9").text_size(10).child(String(c.blocked.length)) : null,
      c.working.length ? h_flex().flex_none().gap(1).items_center().text_color(t.working).font_family("Galmuri9").text_size(10)
        .child(div().frames(["◐", "◓", "◑", "◒"], 160)).child(String(c.working.length)) : null,
      c.done.length ? h_flex().flex_none().gap(1).items_center().text_color(t.done).font_family("Galmuri9").text_size(10)
        .child("★").child(String(c.done.length)) : null,
    ].filter(Boolean);

    // What gives way when the strip is too narrow (measured: about 8 px a letter): the shown tab's
    // cursor, then the hidden tabs' labels, then the shown one's. Icons and numbers stay.
    const digits = (n) => 6 * String(n).length;
    const badgeWidth = (c) => (c.blocked.length ? 13 + digits(c.blocked.length) : 0) + (c.working.length ? 15 + digits(c.working.length) : 0) + (c.done.length ? 15 + digits(c.done.length) : 0);
    const tabWidth = (x, label, cursor) => 25 + (x.on && cursor ? 13 : 0) + (label ? 5 + 8 * x.tab.label.length : 0) + badgeWidth(x.c);
    const room = (this.width ?? Infinity) - 12 - 4 * (items.length - 1);
    const fits = (label, cursor) => items.reduce((n, x) => n + tabWidth(x, label(x), cursor), 0) <= room;
    const all = () => true, shownOnly = (x) => x.on, none = () => false;
    const [labelled, cursor] = fits(all, true) ? [all, true] : fits(all, false) ? [all, false] : fits(shownOnly, false) ? [shownOnly, false] : [none, false];

    return h_flex()
      .id("st-root")
      .on_size_change((size, cx) => {
        if (this.width === size.width) return;
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_w(0)
      .px(6)
      .gap(4)
      .items_center()
      .overflow_hidden()
      .text_size(12)
      .children(items.map((x) => {
        const { tab, c, on } = x;
        return h_flex()
          .id(`st-${tab.child}`)
          .h(22)
          .px(5)
          .gap(5)
          .flex_none()
          .items_center()
          .border(2)
          .border_color(on ? t.accent : alpha(t.border, "70"))
          .bg(on ? alpha(t.accent, "1c") : alpha(t.background, "6b"))
          .text_color(on ? t.foreground : t.muted)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .tooltip(tipOf(tab, c, on))
          .on_click(() => select(tab))
          .when(on && cursor, (el) => el.child(svg(ICON("cursor")).size(8).flex_none().text_color(t.accent)))
          .child(icon(tab, 11))
          .when(labelled(x), (el) => el.child(div().flex_none().child(tab.label)))
          .children(badges(c));
      }));
  }
}
