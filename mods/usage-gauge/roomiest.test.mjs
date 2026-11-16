// node roomiest.test.mjs: checks roomiest.js with accounts shaped like usage.py's usage.json.
import assert from "node:assert/strict";
import { roomiest, shownUse, usable, isRoomiest, MAX_AGE } from "./roomiest.js";

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

const NOW = 1_800_000_000_000;
const acc = (agent, name, windows, extra = {}) => ({ agent, name, windows: windows.map(([label, used, resets]) => ({ label, used, resets: resets ?? null })), checked: NOW - 60000, stale: false, ...extra });

test("shown use: Claude weekly only, Codex its fullest window", () => {
  assert.equal(shownUse(acc("claude", "claude3", [["5h", 40], ["weekly", 13]]), NOW), 13);
  assert.equal(shownUse(acc("claude", "claude", [["5h", 40]]), NOW), 40);
  assert.equal(shownUse(acc("codex", "codex4", [["5h", 0], ["weekly", 3]]), NOW), 3);
  assert.equal(shownUse(acc("codex", "codex9", []), NOW), null);
});

test("picks the least used Claude and Codex account", () => {
  const list = [
    acc("claude", "claude", [["weekly", 30]]),
    acc("claude", "claude2", [["weekly", 29]]),
    acc("claude", "claude3", [["5h", 10], ["weekly", 13]]),
    acc("codex", "codex", [["weekly", 6]]),
    acc("codex", "codex2", [["30d", 50]]),
    acc("codex", "codex4", [["5h", 0], ["weekly", 3]]),
  ];
  assert.deepEqual(roomiest(list, NOW), { claude: { name: "claude3", used: 13 }, codex: { name: "codex4", used: 3 } });
});

test("stale, logged out, missing and old numbers don't count", () => {
  const list = [
    acc("claude", "claude", [["weekly", 0]], { stale: true }),
    acc("claude", "claude2", [["weekly", 1]], { login_needed: true }),
    acc("claude", "claude3", [["weekly", 2]], { checked: NOW - MAX_AGE - 1 }),
    acc("claude", "claude4", [["weekly", null]]),
    acc("claude", "claude5", [["weekly", 60]]),
    acc("codex", "codex", [], {}),
    acc("codex", "codex2", [["weekly", 5]], { checked: undefined }),
  ];
  assert.equal(usable(list[0], NOW), false);
  assert.deepEqual(roomiest(list, NOW), { claude: { name: "claude5", used: 60 }, codex: null });
});

test("a rate-limited read with recent numbers still counts", () => {
  const a = acc("codex", "codex3", [["30d", 4]], { error: "Usage reads for this account are rate-limited." });
  assert.deepEqual(roomiest([a], NOW).codex, { name: "codex3", used: 4 });
});

test("ties: less use in any window, then the first listed", () => {
  const list = [
    acc("claude", "claude", [["5h", 30], ["weekly", 0]]),
    acc("claude", "claude2", [["5h", 5], ["weekly", 0]]),
    acc("codex", "codex3", [["30d", 0]]),
    acc("codex", "codex5", [["weekly", 0]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.claude.name, "claude2");
  assert.equal(best.codex.name, "codex3");
  assert.equal(isRoomiest(best, list[1]), true);
  assert.equal(isRoomiest(best, list[0]), false);
  assert.equal(isRoomiest(null, list[0]), false);
});

test("no accounts", () => {
  assert.deepEqual(roomiest(undefined, NOW), { claude: null, codex: null });
  assert.deepEqual(roomiest([], NOW), { claude: null, codex: null });
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
