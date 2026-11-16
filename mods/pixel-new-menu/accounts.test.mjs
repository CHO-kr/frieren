// node accounts.test.mjs: checks accounts.js with knownAgents() / shared state shaped like this PC's.
import assert from "node:assert/strict";
import { agentRows, runFor } from "./accounts.js";

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

const agents = [
  { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"], installed: true },
  { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true, run: ["codex", "--no-daemon"], installed: true },
  { key: "grok", name: "Grok", icon: "icons/grok.svg", tint: true, run: ["grok"], installed: true },
  { key: "pi", name: "Pi", icon: "icons/pi.svg", tint: true, run: ["pi"], installed: false },
];
const accounts = {
  claude: [{ name: "claude", cmd: "claude", main: true }, { name: "claude2", cmd: "claude2" }, { name: "claude3", cmd: "claude3" }],
  codex: [{ name: "codex", cmd: "codex", main: true }, { name: "codex2", cmd: "codex2" }, { name: "codex3", cmd: "codex3" }],
};

test("main account runs as the menu would, others by their own command", () => {
  assert.deepEqual(runFor(agents[1], accounts.codex[0]), ["codex", "--no-daemon"]);
  assert.deepEqual(runFor(agents[1], accounts.codex[2]), ["codex3"]);
  assert.deepEqual(runFor(agents[0], accounts.claude[1]), ["claude2"]);
});

test("the account with the most left comes first, noted", () => {
  const rows = agentRows(agents, accounts, { claude: { name: "claude3", used: 13 }, codex: { name: "codex2", used: 1 } });
  assert.deepEqual(rows.map((r) => r.key), ["claude:claude3", "claude:claude", "claude:claude2", "codex:codex2", "codex:codex", "codex:codex3", "grok", "pi"]);
  assert.deepEqual(rows.filter((r) => r.most).map((r) => r.name), ["claude3", "codex2"]);
  assert.equal(rows[0].tab, "Claude Code");
  assert.deepEqual(rows[0].run, ["claude3"]);
  assert.deepEqual(rows[4].run, ["codex", "--no-daemon"]);
  assert.equal(rows.at(-1).installed, false);
});

test("no usage data: accounts in their own order, nothing noted", () => {
  const rows = agentRows(agents, accounts, null);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ["claude", "claude2", "claude3"]);
  assert.equal(rows.some((r) => r.most), false);
});

test("an unknown best name or a single account changes nothing", () => {
  const rows = agentRows(agents, { claude: [accounts.claude[0]] }, { claude: { name: "claude9" }, codex: { name: "codex9" } });
  assert.deepEqual(rows.map((r) => r.key), ["claude", "codex", "grok", "pi"]);
  assert.equal(rows[0].tab, "Claude Code");
});

test("bad shared values are ignored", () => {
  const rows = agentRows(agents, { claude: [null, { name: "x" }, { name: "claude2", cmd: "claude2" }], codex: "nope" }, undefined);
  assert.deepEqual(rows.map((r) => r.key), ["claude", "codex", "grok", "pi"]);
  assert.deepEqual(agentRows(undefined, undefined, undefined), []);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
