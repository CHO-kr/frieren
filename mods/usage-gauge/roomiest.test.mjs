// node roomiest.test.mjs: checks roomiest.js with accounts shaped like usage.py's usage.json.
import assert from "node:assert/strict";
import { roomiest, ranking, scoreOf, shownUse, usable, isRoomiest, pace, windowMinutes, spanName, soon, MAX_AGE } from "./roomiest.js";

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
const H = 3600000;
const D = 24 * H;
const acc = (agent, name, windows, extra = {}) => ({ agent, name, windows: windows.map(([label, used, resets, minutes]) => ({ label, used, resets: resets ?? null, ...(minutes ? { minutes } : {}) })), checked: NOW - 60000, stale: false, ...extra });
const names = (best) => ({ claude: best.claude?.name ?? null, codex: best.codex?.name ?? null });

test("shown use: Claude weekly only, Codex its fullest window", () => {
  assert.equal(shownUse(acc("claude", "claude3", [["5h", 40], ["weekly", 13]]), NOW), 13);
  assert.equal(shownUse(acc("claude", "claude", [["5h", 40]]), NOW), 40);
  assert.equal(shownUse(acc("codex", "codex4", [["5h", 0], ["weekly", 3]]), NOW), 3);
  assert.equal(shownUse(acc("codex", "codex9", []), NOW), null);
});

test("no resets known: the most room wins (the fullest window counts)", () => {
  const list = [
    acc("claude", "claude", [["weekly", 30]]),
    acc("claude", "claude2", [["weekly", 29]]),
    acc("claude", "claude3", [["5h", 10], ["weekly", 13]]),
    acc("codex", "codex", [["weekly", 6]]),
    acc("codex", "codex2", [["30d", 50]]),
    acc("codex", "codex4", [["5h", 0], ["weekly", 3]]),
  ];
  const best = roomiest(list, NOW);
  assert.deepEqual(best.claude, { name: "claude3", used: 13, left: 87, why: "claude3: most left (87%)", tag: "most left", order: ["claude3", "claude2", "claude"] });
  assert.deepEqual(best.codex, { name: "codex4", used: 3, left: 97, why: "codex4: most left (97%)", tag: "most left", order: ["codex4", "codex", "codex2"] });
});

test("use it or lose it: 30% resetting in 3h beats 60% resetting in 5 days", () => {
  const list = [
    acc("claude", "claude", [["weekly", 40, NOW + 5 * D]]),
    acc("claude", "claude2", [["weekly", 70, NOW + 3 * H]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.claude.name, "claude2");
  assert.equal(best.claude.why, "claude2: 30% left resets in 3h — spend it first");
  assert.equal(best.claude.tag, "spend first");
  assert.equal(best.claude.used, 70);
  assert.deepEqual(best.claude.order, ["claude2", "claude"]);
  // Two days off, the reset doesn't count yet: the most left wins.
  const later = roomiest([list[0], acc("claude", "claude2", [["weekly", 70, NOW + 3 * D]])], NOW);
  assert.equal(later.claude.why, "claude: most left (60%)");
});

test("the same for Codex, with a 30-day window", () => {
  const list = [
    acc("codex", "codex", [["weekly", 10, NOW + 6 * D]]),
    acc("codex", "codex2", [["30d", 50, NOW + 10 * H]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.codex.name, "codex2");
  assert.equal(best.codex.why, "codex2: 50% left resets in 10h — spend it first");
});

test("an untouched account with days to go doesn't beat leftover about to expire", () => {
  const list = [
    acc("claude", "claude", [["weekly", 0, NOW + 5 * D]]),
    acc("claude", "claude2", [["weekly", 70, NOW + 3 * H]]),
  ];
  assert.equal(roomiest(list, NOW).claude.name, "claude2");
});

test("among accounts to spend first, the most expiring wins", () => {
  const list = [
    acc("claude", "claude", [["weekly", 80, NOW + 2 * H]]), // 20 left
    acc("claude", "claude2", [["weekly", 50, NOW + 12 * H]]), // 50 left, 3/4 counted
  ];
  const r = ranking(list, NOW).claude;
  assert.deepEqual(r.map((s) => s.name), ["claude2", "claude"]);
  assert.ok(Math.abs(r[0].expiring - 37.5) < 1e-9);
});

test("a nearly empty account doesn't win just because it resets", () => {
  const list = [
    acc("claude", "claude", [["weekly", 60, NOW + 5 * D]]),
    acc("claude", "claude2", [["weekly", 92, NOW + 1 * H]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.claude.name, "claude");
  assert.equal(scoreOf(list[1], NOW).first, false);
});

test("never ★ an account about to block: 5-hour window at 90% or any window at 100%", () => {
  const list = [
    acc("claude", "claude", [["5h", 91, NOW + 2 * H], ["weekly", 10, NOW + 4 * H]]),
    acc("claude", "claude2", [["5h", 20, NOW + 2 * H], ["weekly", 100, NOW + 5 * D]]),
    acc("claude", "claude3", [["5h", 50, NOW + 2 * H], ["weekly", 85, NOW + 5 * D]]),
    acc("codex", "codex4", [["5h", 95, NOW + 1 * H], ["weekly", 5, NOW + 6 * D]]),
    acc("codex", "codex5", [["weekly", 70, NOW + 6 * D]]),
  ];
  const best = roomiest(list, NOW);
  assert.deepEqual(names(best), { claude: "claude3", codex: "codex5" });
  // Blocked ones still rank, after the rest.
  assert.deepEqual(best.claude.order, ["claude3", "claude", "claude2"]);
  assert.deepEqual(best.codex.order, ["codex5", "codex4"]);
});

test("every account near a limit: the one with the most room, said so", () => {
  const list = [
    acc("claude", "claude", [["5h", 95, NOW + 2 * H], ["weekly", 40, NOW + 5 * D]]),
    acc("claude", "claude2", [["5h", 92, NOW + 1 * H], ["weekly", 40, NOW + 5 * D]]),
    acc("claude", "claude3", [["weekly", 100, NOW + 3 * D]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.claude.name, "claude2");
  assert.equal(best.claude.tag, "near limit");
  assert.equal(best.claude.why, "claude2: every account is near a limit; most left here (8%)");
  // Same room: the one that frees up first.
  const tie = roomiest([acc("claude", "a", [["5h", 92, NOW + 3 * H]]), acc("claude", "b", [["5h", 92, NOW + 1 * H]])], NOW);
  assert.equal(tie.claude.name, "b");
});

test("a window past its reset since the reading counts as reset", () => {
  const list = [
    acc("claude", "claude", [["5h", 95, NOW - 60000], ["weekly", 30, NOW + 5 * D]]),
    acc("claude", "claude2", [["weekly", 50, NOW + 5 * D]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.claude.name, "claude");
  assert.equal(best.claude.left, 70);
});

test("the 5-hour window's leftover isn't use-it-or-lose-it", () => {
  const list = [
    acc("codex", "codex4", [["5h", 10, NOW + 10 * 60000], ["weekly", 60, NOW + 6 * D]]),
    acc("codex", "codex5", [["weekly", 30, NOW + 6 * D]]),
  ];
  const best = roomiest(list, NOW);
  assert.equal(best.codex.name, "codex5");
  assert.equal(scoreOf(list[0], NOW).expiring, 0);
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
  const best = roomiest(list, NOW);
  assert.deepEqual(names(best), { claude: "claude5", codex: null });
  assert.deepEqual(best.claude.order, ["claude5"]);
  // A stale account with leftover about to expire still doesn't count.
  const stale = acc("claude", "claude", [["weekly", 70, NOW + 3 * H]], { stale: true });
  assert.equal(roomiest([stale, list[4]], NOW).claude.name, "claude5");
});

test("a rate-limited read with recent numbers still counts", () => {
  const a = acc("codex", "codex3", [["30d", 4]], { error: "Usage reads for this account are rate-limited." });
  assert.equal(roomiest([a], NOW).codex.name, "codex3");
  assert.equal(roomiest([a], NOW).codex.used, 4);
});

test("ties: the long window that resets first, then the first listed", () => {
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
  const timed = roomiest([acc("codex", "codex", [["weekly", 20, NOW + 6 * D]]), acc("codex", "codex2", [["weekly", 20, NOW + 4 * D]])], NOW);
  assert.equal(timed.codex.name, "codex2");
});

test("no accounts", () => {
  assert.deepEqual(roomiest(undefined, NOW), { claude: null, codex: null });
  assert.deepEqual(roomiest([], NOW), { claude: null, codex: null });
  assert.deepEqual(ranking([null, { agent: "grok", name: "x" }], NOW), { claude: [], codex: [] });
});

test("window lengths: usage.py's minutes, else the label", () => {
  assert.equal(windowMinutes({ label: "5h" }), 300);
  assert.equal(windowMinutes({ label: "weekly" }), 10080);
  assert.equal(windowMinutes({ label: "30d" }), 43200);
  assert.equal(windowMinutes({ label: "weekly", minutes: 10000 }), 10000);
  assert.equal(windowMinutes({ label: "limit" }), null);
  assert.equal(windowMinutes(null), null);
  assert.equal(spanName(10080), "week");
  assert.equal(spanName(300), "5 hours");
  assert.equal(spanName(43200), "30 days");
  assert.equal(spanName(1440), "day");
  assert.equal(spanName(null), "window");
  assert.equal(soon(45 * 60000), "45m");
  assert.equal(soon(3 * H + 20 * 60000), "3h");
  assert.equal(soon(5 * D), "5d");
});

test("pace: the share of the window's time gone, and ahead of it", () => {
  // A week with 4 days left: 3/7 gone.
  const w = { label: "weekly", used: 62, resets: NOW + 4 * D };
  const p = pace(w, NOW);
  assert.ok(Math.abs(p.elapsed - 3 / 7) < 1e-9);
  assert.equal(p.ahead, true);
  // 62% in 3 days: 100% after 3 * 100/62 days from the start.
  const start = NOW - 3 * D;
  assert.equal(p.runsOut, Math.round(start + (3 * D * 100) / 62));
  assert.ok(p.runsOut < w.resets && p.runsOut > NOW);
  // On pace (within the margin) or behind: no warning, no run-out.
  assert.equal(pace({ ...w, used: 45 }, NOW).ahead, false);
  assert.equal(pace({ ...w, used: 10 }, NOW).runsOut, null);
  // 5-hour window, 1 hour left.
  const short = pace({ label: "5h", used: 50, resets: NOW + H }, NOW);
  assert.ok(Math.abs(short.elapsed - 0.8) < 1e-9);
  assert.equal(short.ahead, false);
  // usage.py's minutes win over the label.
  assert.ok(Math.abs(pace({ label: "weekly", used: 0, resets: NOW + D, minutes: 2 * 1440 }, NOW).elapsed - 0.5) < 1e-9);
});

test("pace: unknown length, reset or use, or a passed reset, gives nothing", () => {
  assert.equal(pace({ label: "limit", used: 5, resets: NOW + H }, NOW), null);
  assert.equal(pace({ label: "weekly", used: 5, resets: null }, NOW), null);
  assert.equal(pace({ label: "weekly", used: null, resets: NOW + H }, NOW), null);
  assert.equal(pace({ label: "weekly", used: 5, resets: NOW - 1 }, NOW), null);
  // At 100% it is ahead (the danger color wins), with no run-out to tell.
  const full = pace({ label: "5h", used: 100, resets: NOW + 2 * H }, NOW);
  assert.equal(full.ahead, true);
  assert.equal(full.runsOut, null);
  // A reading from before: the rate is taken when it was read, and the run-out is never in the past.
  const old = pace({ label: "5h", used: 60, resets: NOW + 3 * H }, NOW, NOW - H);
  assert.equal(old.runsOut, NOW);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
