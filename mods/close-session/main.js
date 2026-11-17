// Cmd+W (keys.json global "cmd-w": "mod.open:close-session"): closes the focused session but never its space.
// - a tab with several panes: closes the focused pane only;
// - a space with several tabs: closes the focused tab;
// - the space's last session: opens a fresh shell tab in the space's folder first, then closes the old one,
//   so the space stays.
// It opens as an invisible 1x1 popup (so it works in every layout), does that, and closes itself.
import { View, div } from "gpui-kit";
import { focused, panes, spaces, run, props, closeOverlay, checking } from "herdr";

export default class CloseSession extends View {
  init() {
    if (checking()) return;
    try { this.act(); } finally { const id = props()?.overlay; if (id) closeOverlay(id); }
  }

  act() {
    const f = focused();
    if (!f?.tab) return;
    if (!f.pane) { run("tab.close", { id: f.tab }); return; } // a layout terminal block: leave it to the tab
    const inTab = panes().filter((p) => p.tab === f.tab);
    if (inTab.length > 1) { run("pane.close", { pane: f.pane }); return; }
    const space = spaces().find((s) => s.id === f.space);
    if ((space?.tabs?.length ?? 0) > 1) { run("tab.close", { id: f.tab }); return; }
    const folder = space?.folder ?? f.cwd ?? undefined;
    run("tab.new", { space: f.space, ...(folder ? { folder } : {}), focus: true });
    run("tab.close", { id: f.tab, confirmed: true });
  }

  render() {
    return div();
  }
}
