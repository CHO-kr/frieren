// The + menu's agent rows (pure, tested by `node accounts.test.mjs`). Claude Code and Codex become one row per account
// when there is more than one: the session panels share their accounts ("sessions.claude" / "sessions.codex":
// [{ name, cmd, main }]), usage-gauge shares the one with the most left ("usage.roomiest": { claude, codex }: { name } | null).
// That account comes first and says "most left"; the others keep their order. Other agents stay one row each.
// A row: { key, name, icon, tint, installed, run, tab, account, most }. `tab` names the tab it opens (the agent's name,
// as the shipped menu does).

export const MOST_LEFT = "most left";

// How an account starts. The main one as the menu starts the agent ("codex --no-daemon"); another by its own command
// alone: its wrapper (codex2.cmd, claude2.cmd) sets its login folder and already adds --no-daemon for Codex, which
// refuses the flag twice. The main Claude account is the one the Claude desktop app signs in with, so its sessions
// start with Remote Control and show in the app's list (named "herdr-…"); claude2/claude3 are other logins.
const REMOTE = ["--remote-control", "--remote-control-session-name-prefix", "herdr"];
const withRemote = (argv) => (argv.includes("--remote-control") ? argv : [...argv, ...REMOTE]);

export function runFor(agent, account) {
  if (account.main) {
    const argv = Array.isArray(agent.run) && agent.run.length ? [...agent.run] : [account.cmd];
    return kindOf(agent) === "claude" ? withRemote(argv) : argv;
  }
  return [account.cmd];
}

const kindOf = (agent) => (agent?.key === "claude" ? "claude" : agent?.key === "codex" ? "codex" : null);

export function agentRows(agents, accounts, best) {
  const rows = [];
  for (const a of agents ?? []) {
    const kind = kindOf(a);
    const given = kind && a.installed ? accounts?.[kind] : null;
    const list = (Array.isArray(given) ? given : []).filter((x) => x && typeof x.name === "string" && typeof x.cmd === "string" && x.cmd);
    if (list.length < 2) {
      const run = kind === "claude" && Array.isArray(a.run) && a.run.length ? withRemote(a.run) : a.run;
      rows.push({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, installed: a.installed, run, tab: a.name, account: null, most: false });
      continue;
    }
    const top = best?.[kind]?.name ?? null;
    const first = list.filter((x) => x.name === top);
    for (const x of [...first, ...list.filter((x) => x.name !== top)]) {
      rows.push({ key: `${a.key}:${x.name}`, name: x.name, icon: a.icon, tint: a.tint, installed: true, run: runFor(a, x), tab: a.name, account: x.name, agent: a.name, most: x.name === top });
    }
  }
  return rows;
}
