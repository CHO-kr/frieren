// pixel-tabs' own helpers, pure (no herdr / gpui-kit calls), tested by `node names.test.mjs`. lib.js is a copy shared
// with pixel-party and pixel-pane, so what only the tab bar needs lives here.
//   - a name for a tab nobody named (TabInfo.named false, its name is its number): the title of the agent session it
//     resumed, else its first pane's repo or folder, else its program. The tab itself is never renamed.
//   - a color mark per project (the repo root, else the folder, of the tab's first pane): a hash into eight colors made
//     from theme() (its terminal palette, touched with the scene's foreground).
import { launched, cleanText, mix } from "./lib.js";

export const SOURCES = { session: "the agent session", repo: "the repo", folder: "the folder", program: "the program" };
export const unnamedTip = (source) => `Unnamed tab: name shown from ${SOURCES[source] ?? source}`;

// A tab nobody named. `named` is in TabInfo; without it, a name that is just its number.
export const isUnnamed = (tab) => tab?.named === false || (tab?.named == null && String(tab?.name ?? "") === String(tab?.index ?? ""));

// "C:\\Users\\x\\repo\\" -> "C:/Users/x/repo"
export const slashes = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/(.)\/+$/, "$1");

// The last folder of a path; "~" for the home folder.
export function baseName(path, home) {
  const p = slashes(path);
  if (!p) return null;
  if (home && p.toLowerCase() === slashes(home).toLowerCase()) return "~";
  return p.split("/").filter(Boolean).pop() ?? p;
}

// One project, wherever it's written from (case and slashes as Windows paths allow), per machine.
export const projectKey = (machine, dir) => `${machine ?? ""}|${slashes(dir).toLowerCase()}`;

// FNV-1a: the same project always gets the same color.
export function hash(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const hex = (c) => (typeof c === "string" && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : null);

// Red, orange, yellow, green, teal, blue, purple, pink: the theme's ansi colors (light on every scene's dark wood or
// night sky), orange and pink mixed from them, each with a little of the scene's foreground so they follow the hour.
export function projectPalette(t) {
  const [r, y, g, b, p, c] = ["ansi1", "ansi3", "ansi2", "ansi4", "ansi5", "ansi6"].map((k) => hex(t?.[k]));
  const list = [r, r && y ? mix(r, y, 0.5) : null, y, g, c, b, p, r && p ? mix(r, p, 0.5) : null].filter(Boolean);
  const fg = hex(t?.foreground);
  return fg ? list.map((x) => mix(x, fg, 0.12)) : list;
}

export function projectColor(key, t) {
  const pal = projectPalette(t);
  return key && pal.length ? pal[hash(key) % pal.length] : null;
}

// The title of the agent session a terminal resumed (launched(argv).resume), from the session panels' caches
// (claude-list.json sessions, codex-list.json threads), matched as pixel-party's facts() does.
export function sessionTitle(argv, app, claude, codex) {
  const start = launched(argv);
  if (!start?.resume) return null;
  const isCodex = /codex/i.test(`${app ?? ""} ${start.account ?? ""}`);
  const found = isCodex
    ? (codex ?? []).find((s) => s?.id === start.resume)
    : (claude ?? []).find((s) => s?.cli === start.resume || s?.path === start.resume || s?.id === start.resume);
  // a line break is a space (cleanText drops control characters outright)
  return cleanText(typeof found?.title === "string" ? found.title.replace(/\s+/g, " ") : null, 60);
}

// What a tab is about. qs: its panes() in order. argvOf(address) -> argv; rootOf(cwd) -> the repo root, null (no repo)
// or undefined (not known yet: the folder stands in). -> { name: { text, source } | null, project: { key, name, repo } | null }
export function tabFacts(qs, { argvOf, rootOf, claude, codex, home, machine } = {}) {
  const list = qs ?? [];
  const first = list.find((q) => q?.terminal && q.cwd) ?? list.find((q) => q?.cwd) ?? null;
  let project = null;
  if (first) {
    const root = rootOf?.(first.cwd);
    const dir = root || first.cwd;
    project = { key: projectKey(machine, dir), name: baseName(dir, home), repo: Boolean(root) };
  }
  let session = null;
  for (const q of list) {
    if (!q?.terminal) continue;
    session = sessionTitle(argvOf?.(q.terminal), q.app ?? q.program?.key, claude, codex);
    if (session) break;
  }
  const lead = list.find((q) => q?.program?.agent) ?? list[0];
  const program = cleanText(lead?.program?.name ?? lead?.title ?? null, 40);
  const name = session ? { text: session, source: "session" }
    : project?.name ? { text: project.name, source: project.repo ? "repo" : "folder" }
      : program ? { text: program, source: "program" } : null;
  return { name, project };
}
