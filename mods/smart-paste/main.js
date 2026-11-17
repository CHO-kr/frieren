// Ctrl+V in a terminal (keys.json "terminal": { "ctrl-v": "smart-paste.paste" }). Text and
// copied files paste at once, as Herdr's own paste (Ctrl+Shift+V) does. A screenshot alone on the
// clipboard Herdr can't paste on Windows, so clip.py saves it as a PNG, puts that file on the
// clipboard, and it is pasted again as a file: Claude Code and Codex attach it.
// Draws nothing; it sits in a zero-width block so it is always shown and gets the command.

import { View, div } from "gpui-kit";
import { exec, run, appHome, nextCommand, window, home } from "herdr";

// window() can be null while the app starts: ask each time, and until it answers tell by the home folder.
const platform = () => window()?.platform ?? (/^[A-Za-z]:[\\/]/.test(home()) ? "windows" : home().startsWith("/Users/") ? "macos" : "linux");
const PY = () => (platform() === "windows" ? "python" : "python3");

export default class SmartPaste extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        if (!String(await nextCommand()).endsWith("paste")) continue;
        run("terminal.paste");
        try {
          const r = await exec(PY(), ["-X", "utf8", `${appHome()}/mods/smart-paste/clip.py`]);
          if (r.code === 0 && r.stdout.trim() === "image") run("terminal.paste");
        } catch {}
      }
    });
  }

  render() {
    return div();
  }
}
