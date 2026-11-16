// node names.test.mjs: checks names.js with panes / terminals / session caches shaped like Herdr's and this PC's.
import assert from "node:assert/strict";
import { isUnnamed, slashes, baseName, projectKey, hash, projectPalette, projectColor, sessionTitle, tabFacts, unnamedTip } from "./names.js";

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
};

const HOME = "C:\\Users\\me";
const claude = [{ id: "local_1", cli: "aaaa-1111", path: "C:/Users/me/.claude/projects/x/aaaa-1111.jsonl", title: "Fix the login bug" }];
const codex = [{ id: "019a-thread", title: "Port the parser\nto Rust" }];
const terms = {
  t1: ["pwsh", "-NoExit", "-Command", "& 'claude2' '--resume' 'aaaa-1111' '--model' 'opus'"],
  t2: ["pwsh", "-NoExit", "-Command", "& 'codex3' 'resume' '019a-thread' '-c' 'sqlite_home=C:/x'"],
  t3: ["pwsh"],
};
const argvOf = (a) => terms[a];
const pane = (terminal, cwd, extra = {}) => ({ pane: `p-${terminal}`, terminal, tab: "tb1", cwd, app: null, program: { key: "shell", name: "pwsh", agent: false }, ...extra });
const theme = { ansi1: "#ff7a6b", ansi2: "#8fe39b", ansi3: "#ffd36a", ansi4: "#86b4ff", ansi5: "#c49bff", ansi6: "#6fe0c8", foreground: "#f7e9d3" };

test("unnamed tabs", () => {
  assert.equal(isUnnamed({ name: "6", index: 6, named: false }), true);
  assert.equal(isUnnamed({ name: "fix login", index: 2, named: true }), false);
  assert.equal(isUnnamed({ name: "3", index: 3 }), true);
  assert.equal(isUnnamed({ name: "Claude Code", index: 3 }), false);
});

test("paths", () => {
  assert.equal(slashes("C:\\Users\\me\\repo\\"), "C:/Users/me/repo");
  assert.equal(baseName("C:\\Users\\me\\my-videos", HOME), "my-videos");
  assert.equal(baseName("C:/Users/me/", HOME), "~");
  assert.equal(baseName("/srv/api/", null), "api");
  assert.equal(baseName("", HOME), null);
  assert.equal(projectKey(null, "C:\\Users\\Me\\Repo"), projectKey(null, "c:/users/me/repo/"));
  assert.notEqual(projectKey("vps", "/srv/api"), projectKey(null, "/srv/api"));
});

test("colors: stable per project, from the theme", () => {
  const pal = projectPalette(theme);
  assert.equal(pal.length, 8);
  assert.ok(pal.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.equal(new Set(pal).size, 8);
  const k = projectKey(null, "C:/Users/me/my-videos");
  assert.equal(projectColor(k, theme), projectColor(projectKey(null, "c:\\users\\me\\my-videos\\"), theme));
  assert.equal(projectColor(k, theme), pal[hash(k) % 8]);
  assert.equal(projectColor(null, theme), null);
  assert.deepEqual(projectPalette({}), []);
  // a night scene's foreground changes the tint, not which slot a project gets
  const night = { ...theme, foreground: "#cde2fd" };
  assert.equal(projectPalette(night).indexOf(projectColor(k, night)), pal.indexOf(projectColor(k, theme)));
});

test("session titles from the caches", () => {
  assert.equal(sessionTitle(terms.t1, "claude-code", claude, codex), "Fix the login bug");
  assert.equal(sessionTitle(terms.t2, "codex", claude, codex), "Port the parser to Rust");
  assert.equal(sessionTitle(terms.t3, null, claude, codex), null);
  assert.equal(sessionTitle(["pwsh", "-Command", "& 'claude' '--resume' 'zzzz'"], null, claude, codex), null);
  assert.equal(sessionTitle(undefined, null, undefined, undefined), null);
});

test("tab facts: session, then repo, then folder, then program", () => {
  const roots = { "C:\\Users\\me\\my-videos\\tools": "C:/Users/me/my-videos" };
  const rootOf = (cwd) => (cwd in roots ? roots[cwd] : null);
  const opts = { argvOf, rootOf, claude, codex, home: HOME, machine: null };

  const s = tabFacts([pane("t3", "C:\\Users\\me\\my-videos\\tools"), pane("t1", "C:\\Users\\me\\x", { app: "claude-code", program: { key: "claude", name: "Claude Code", agent: true } })], opts);
  assert.deepEqual(s.name, { text: "Fix the login bug", source: "session" });
  assert.equal(s.project.name, "my-videos");
  assert.equal(s.project.repo, true);

  const r = tabFacts([pane("t3", "C:\\Users\\me\\my-videos\\tools")], opts);
  assert.deepEqual(r.name, { text: "my-videos", source: "repo" });

  const f = tabFacts([pane("t3", "C:\\Users\\me\\Downloads")], opts);
  assert.deepEqual(f.name, { text: "Downloads", source: "folder" });
  assert.equal(f.project.repo, false);

  const h = tabFacts([pane("t3", "C:\\Users\\me")], opts);
  assert.deepEqual(h.name, { text: "~", source: "folder" });

  // the repo not known yet: its folder stands in
  const u = tabFacts([pane("t3", "C:\\Users\\me\\my-videos\\tools")], { ...opts, rootOf: () => undefined });
  assert.deepEqual(u.name, { text: "tools", source: "folder" });

  // a mod pane: no folder, its title
  const m = tabFacts([{ pane: "p9", terminal: null, mod: "files", tab: "tb1", title: "Files" }], opts);
  assert.deepEqual(m.name, { text: "Files", source: "program" });
  assert.equal(m.project, null);

  assert.deepEqual(tabFacts([], opts), { name: null, project: null });
  assert.equal(unnamedTip("repo"), "Unnamed tab: name shown from the repo");
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
