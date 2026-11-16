// Frieren pixel party: pure functions only (no herdr / gpui-kit calls).
// pixel-party, pixel-tabs and pixel-pane each keep a copy of this file (a mod can't import outside its folder). Change all three.
// Character picks are shared with the journey layout (shared "journey.party", journey-party/jobs.json), so a tab keeps its character.

export const ROSTER = [
  { id: "frieren", name: "Frieren", role: "Great Mage", color: "#7fe0b8", style: "bolt" },
  { id: "fern", name: "Fern", role: "Mage", color: "#c49bff", style: "bolt" },
  { id: "stark", name: "Stark", role: "Warrior", color: "#ff7a6b", style: "slash" },
  { id: "himmel", name: "Himmel", role: "Hero", color: "#86b4ff", style: "slash" },
  { id: "heiter", name: "Heiter", role: "Priest", color: "#aef0b6", style: "holy" },
  { id: "eisen", name: "Eisen", role: "Warrior", color: "#ffd36a", style: "slash" },
  { id: "sein", name: "Sein", role: "Priest", color: "#e0b48a", style: "holy" },
  { id: "ubel", name: "Ubel", role: "First-Class Mage", color: "#8fe39b", style: "slash" },
  { id: "land", name: "Land", role: "First-Class Mage", color: "#e6dca6", style: "bolt" },
  { id: "denken", name: "Denken", role: "First-Class Mage", color: "#e0b48a", style: "bolt" },
  { id: "methode", name: "Methode", role: "First-Class Mage", color: "#ffb0dc", style: "bolt" },
  { id: "flamme", name: "Flamme", role: "Great Mage", color: "#ffc25c", style: "bolt" },
  { id: "serie", name: "Serie", role: "Great Mage", color: "#ffe39a", style: "bolt" },
  { id: "kanne", name: "Kanne", role: "Mage", color: "#ffa070", style: "bolt" },
  { id: "lawine", name: "Lawine", role: "Mage", color: "#a8f2ff", style: "bolt" },
  { id: "wirbel", name: "Wirbel", role: "First-Class Mage", color: "#cbd5e8", style: "bolt" },
];
const BY_ID = new Map(ROSTER.map((c) => [c.id, c]));
export const character = (id) => BY_ID.get(id) ?? null;
export const facePath = (c) => (c ? `mods/pixel-party/faces/${c.id}.png` : null);
// Each character's animations live in its own color pixel font (mods/pixel-party/fonts/FrierenDot<v>-<id>.ttf).
// The version is in the family name: Herdr keeps a loaded family in memory, so a rebuilt font needs a new name.
export const FONT_VERSION = 3;
export const familyOf = (c) => `FrierenDot${FONT_VERSION} ${c.name}`;

// Sprite animations: one glyph per frame. Stage glyphs are 80x32 art pixels (the session header), solo glyphs 36x32
// (the party card). Shown at text_size 64 with line_height 1, so one art pixel is 2x2 screen pixels.
const ANIMS = {
  rest: [0xe000, 4, 450],
  stand: [0xe004, 2, 650],
  think: [0xe006, 4, 170],
  cast: [0xe00a, 12, 90],
  read: [0xe016, 6, 220],
  write: [0xe01c, 8, 150],
  fly: [0xe024, 6, 140],
  summon: [0xe02a, 8, 130],
  alert: [0xe032, 2, 380],
  victory: [0xe034, 8, 170],
};
export const ART = { height: 32, stage: 80, solo: 36, scale: 2 };
export function frames(anim, solo) {
  const [base, n, ms] = ANIMS[anim] ?? ANIMS.stand;
  const first = base + (solo ? 0x400 : 0);
  return { list: Array.from({ length: n }, (_, i) => String.fromCodePoint(first + i)), ms };
}

// What a status and the current activity look like.
export function animFor(status, activity) {
  if (status === "blocked") return "alert";
  if (status === "done") return "victory";
  if (status === "working") return activity?.kind ?? "think";
  if (status === "idle") return "rest";
  return "stand";
}

const ATTACK = { bolt: "casts a spell", slash: "strikes", holy: "casts holy light" };
// The RPG battle line for a header or card: "Frieren casts a spell!  npm test"
export function battleLine(ch, status, activity) {
  const anim = animFor(status, activity);
  const who = ch.name;
  const lines = {
    alert: `${who} calls for help! Needs your answer`,
    victory: `Quest complete!`,
    rest: `${who} is resting… Zzz`,
    stand: `${who} · standing by`,
    think: `${who} walks on, thinking…`,
    cast: `${who} ${ATTACK[ch.style] ?? ATTACK.bolt}!`,
    read: `${who} reads the grimoire`,
    write: `${who} carves runes`,
    fly: `${who} scouts with flight magic`,
    summon: `${who} summons an ally!`,
  };
  return { anim, text: lines[anim] ?? lines.stand, detail: anim === "think" || anim === "rest" || anim === "stand" ? null : activity?.detail ?? null };
}

// ----- reading what an agent is doing from its screen (`hc read <terminal>`) -----
// Claude Code shows each tool as a top-level line (indent ≤ 2) whose ● blinks while it runs, so it may be missing:
//   "● Update(src/x.ts)", "● Web Search(...)", "● Fetch(...)", "● Explore(...)"/"● Agent(...)"   a tool call
//   "  <description>" + "  ⎿  $ npm test"                                                     a shell command running
//   "  Reading 1 file… (ctrl+o to expand)", "  Searching for 2 patterns, reading 1 file…"      a read/search group running
//   "  Read 1 file, ran 2 shell commands"                                                      a finished group: thinking again
//   "● <prose>"                                                                                the model talking: thinking
// Codex: "• Running npm test", "• Ran ...", "• Explored", "• Edited x.ts", "• Searched the web".
// The lowest such line above the prompt is the current activity.
const SKIP = /esc to interrupt|⏵⏵|shift\+tab|^\s*[│╭╰─┌└]|^\s*[❯›>](?:\s|$)|^\s*$/;
const SPINNER = /^\s*[^\w\s●⏺•⎿]\s+\S+…/; // "✶ Working… (31m · ↓ 23k tokens)"
const TOP = /^(\s{0,2})([●⏺•]\s+)?(\S.*)$/;
const RULES = [
  ["summon", /^(?:Agent|Task|Explore|Plan|Spawn(?:ed|ing)?|Launch(?:ed|ing)? \S+ agents?)\b|sub-?agent/i],
  ["fly", /^(?:Web ?Search(?:ed|ing)?|Web ?Fetch|Fetch(?:ed|ing)?|Search(?:ed|ing)? the web|Brows(?:e|ed|ing)|web\.run)\b/i],
  ["write", /^(?:Update[d]?|Updating|Edit(?:ed|ing)?|MultiEdit|Write|Wrote|Writing|Creat(?:e|ed|ing)|NotebookEdit|Added|Deleted|Patch(?:ed|ing)?|Made \d+ \S*\s*edits?)\b|apply_patch/i],
  ["read", /^(?:Read(?:ing)?|Search(?:ed|ing)?|Grep|Glob|List(?:ed|ing)?|Explor(?:e|ed|ing)|Found|Skill|Look(?:ed|ing) at|Scann(?:ed|ing))\b/i],
  ["cast", /^(?:Bash|PowerShell|Shell|Run(?:ning)?|Ran|Exec(?:ut(?:ed|ing))?|Monitor)\b/i],
];
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\(ctrl\+o to expand\)/g, "").replace(/\s+/g, " ").trim();
const kindOf = (text) => RULES.find(([, re]) => re.test(text))?.[0] ?? null;
export function classify(screen) {
  const lines = String(screen ?? "").split(/\r?\n/).slice(-80);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (SKIP.test(line) || SPINNER.test(line)) continue;
    const m = line.match(TOP);
    if (!m) continue; // deeper lines: a diff, a tool's output
    const bullet = Boolean(m[2]);
    const head = clean(m[3]).replace(/\s·\s\d+(?:\.\d+)?m?s$/, "").replace(/\s·\ssummary$/, "");
    if (/^⎿/.test(head)) continue; // a tool's result line
    if (/^(?:Working|Thinking)\b.*\(/.test(head)) continue; // a Codex spinner
    // a shell command running under this line
    const cmd = lines.slice(i + 1, i + 4).map(clean).map((l) => l.match(/^⎿\s*\$\s*(.+)$/)).find(Boolean);
    if (cmd) return { kind: "cast", detail: cut(/^\w[\w ]*\(.*\)$/.test(head) ? cmd[1] : head) };
    // a tool call: Name(args)
    const call = head.match(/^(\w[\w ]*?)\s*\((.*)\)$/);
    if (call && kindOf(call[1])) return { kind: kindOf(call[1]), detail: cut(call[2]) };
    // a group of tools: the last part is what runs now; finished groups (no "…") mean it's thinking again
    if (/…$/.test(head)) {
      const part = head.replace(/…$/, "").split(/,\s*/).pop();
      const k = kindOf(part);
      if (k) return { kind: k, detail: cut(head) };
    }
    if (!bullet) {
      if (/^(?:Read|Searched|Ran|Listed|Found|Fetched|Wrote|Edited|Made|Updated|Created)\b.*\d/.test(head)) return { kind: "think", detail: null };
      continue; // a wrapped line of prose, or a blinking ● — keep looking up
    }
    const k = kindOf(head); // Codex: "• Running npm test", "• Explored"
    return k ? { kind: k, detail: cut(head.replace(RULES.find(([n]) => n === k)[1], "").replace(/^[\s:·-]+/, "") || head) } : { kind: "think", detail: null };
  }
  return { kind: "think", detail: null };
}
function cut(s, max = 60) {
  const t = clean(String(s ?? ""));
  return [...t].length > max ? [...t].slice(0, max - 1).join("") + "…" : t;
}

// ----- shared with the journey layout -----
const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

// Tab name → character: jobs.json first, then a tab named after a character gets that character.
export function characterFor(name, jobs) {
  const wanted = norm(name);
  if (!wanted) return null;
  if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
    for (const key of Object.keys(jobs)) {
      if (norm(key) !== wanted) continue;
      const c = BY_ID.get(norm(jobs[key]));
      if (c) return c.id;
    }
  }
  const named = ROSTER.find((c) => norm(c.name) === wanted || c.id === wanted || c.ko === wanted);
  return named ? named.id : null;
}

// Slots that get a character: tabs with an agent first (screen order), then shell-only tabs, last a tab's second and
// later agents. Keys are tab ids / terminal addresses, so a renamed tab keeps its character.
export function entriesFor(spaces, agents) {
  const withAgent = new Set((agents ?? []).map((a) => a.tab));
  const tabs = (spaces ?? []).flatMap((s) => s.tabs ?? []);
  const entries = [
    ...tabs.filter((t) => withAgent.has(t.id)).map((t) => ({ key: `tab:${t.id}`, name: t.name })),
    ...tabs.filter((t) => !withAgent.has(t.id)).map((t) => ({ key: `tab:${t.id}`, name: t.name })),
  ];
  const first = new Map();
  for (const a of agents ?? []) {
    if (!first.has(a.tab)) first.set(a.tab, a.address);
    else entries.push({ key: `agent:${a.address}`, name: null });
  }
  return entries;
}

export function agentKey(a, agents) {
  const first = (agents ?? []).find((x) => x.tab === a.tab);
  return first && first.address !== a.address ? `agent:${a.address}` : `tab:${a.tab}`;
}

// jobs.json and name matches win, characters already given stay, new slots take the next free one (repeat after 16).
export function settle(prev, entries, jobs) {
  const next = {};
  const used = new Set();
  for (const e of entries) {
    const c = characterFor(e.name, jobs);
    if (c && !used.has(c)) { next[e.key] = c; used.add(c); }
  }
  for (const e of entries) {
    if (next[e.key]) continue;
    const c = prev?.[e.key];
    if (BY_ID.has(c) && !used.has(c)) { next[e.key] = c; used.add(c); }
  }
  for (const e of entries) {
    if (next[e.key]) continue;
    if (used.size >= ROSTER.length) used.clear();
    const c = ROSTER.find((r) => !used.has(r.id)).id;
    next[e.key] = c;
    used.add(c);
  }
  return next;
}

function words(argv) {
  return (argv ?? []).flatMap((a) => String(a).match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));
}

// The account, model and resumed session an agent tab started with. null for an agent typed by hand.
export function launched(argv) {
  const w = words(argv);
  const at = w.findIndex((x) => /^(claude|codex)\d*(\.cmd|\.exe)?$/i.test(x.split(/[\\/]/).pop()));
  if (at < 0) return null;
  const after = (...names) => {
    const i = w.findIndex((x, n) => n > at && names.includes(x));
    return i >= 0 ? w[i + 1] ?? null : null;
  };
  const account = w[at].split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, "").toLowerCase();
  return { account, model: after("--model", "-m"), resume: after("--resume", "resume") };
}

// claude-opus-5-5 → Opus 5.5, opus → Opus, anything else as is.
export function modelName(m) {
  if (typeof m !== "string" || !m.trim()) return null;
  const s = m.trim();
  const full = s.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (full) return `${full[1][0].toUpperCase()}${full[1].slice(1)} ${full[2]}.${full[3]}`;
  if (/^(opus|sonnet|haiku|fable)$/i.test(s)) return s[0].toUpperCase() + s.slice(1).toLowerCase();
  return s;
}

const BAD_CHARS = new RegExp("[" + [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]", "g");
export function cleanText(value, max = 80) {
  if (typeof value !== "string") return null;
  const s = value.replace(BAD_CHARS, "").replace(/\s+/g, " ").trim();
  return s === "" ? null : [...s].slice(0, max).join("");
}

// One account in usage.json → what's left of HP (the short window, e.g. 5h) and MP (weekly, else the longest).
export function gauges(acc, now) {
  const ws = (acc?.windows ?? []).map((w) => (acc.stale && w.resets != null && w.resets <= now ? { ...w, used: null } : w));
  const short = ws.find((w) => /^\d+h$/.test(w.label ?? "")) ?? null;
  const long = ws.find((w) => w.label === "weekly") ?? ws.filter((w) => w !== short).at(-1) ?? null;
  const one = (w, what) => {
    if (!w) return { pct: null, text: "—", tip: `${what}: this account has no such limit.` };
    if (w.used == null) return { pct: null, text: "—", tip: `${what} (${w.label}): not known yet` };
    const left = Math.max(0, Math.min(100, 100 - w.used));
    return { pct: left, text: `${left}%`, tip: `${what} (${w.label}): ${left}% left · ${w.used}% used${w.resets ? ` · resets ${until(w.resets, now)}` : ""}`, stale: Boolean(acc.stale) };
  };
  return { hp: one(short, "HP"), mp: one(long, "MP") };
}

export function until(ms, now) {
  const m = Math.max(0, Math.round((ms - now) / 60000));
  if (m < 60) return `in ${m}m`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
