// Frieren journey party: pure functions only (no herdr / gpui-kit calls).
// journey-party and journey-tabs each keep a copy of this file (a mod can't import outside its folder). Change both.

export const ROSTER = [
  { id: "frieren", name: "Frieren", ko: "프리렌", role: "Great Mage", color: "#7fd1b0" },
  { id: "fern", name: "Fern", ko: "페른", role: "Mage", color: "#b493de" },
  { id: "stark", name: "Stark", ko: "슈타르크", role: "Warrior", color: "#e0705f" },
  { id: "himmel", name: "Himmel", ko: "힘멜", role: "Hero", color: "#86aee8" },
  { id: "heiter", name: "Heiter", ko: "하이터", role: "Priest", color: "#a8dba2" },
  { id: "eisen", name: "Eisen", ko: "아이젠", role: "Warrior", color: "#d9b766" },
  { id: "sein", name: "Sein", ko: "자인", role: "Priest", color: "#c9a27a" },
  { id: "ubel", name: "Ubel", ko: "위벨", role: "First-Class Mage", color: "#8fc98a" },
  { id: "land", name: "Land", ko: "란트", role: "First-Class Mage", color: "#d8cf9a" },
  { id: "denken", name: "Denken", ko: "덴켄", role: "First-Class Mage", color: "#c9a27a" },
  { id: "methode", name: "Methode", ko: "메토데", role: "First-Class Mage", color: "#d6b48c" },
  { id: "flamme", name: "Flamme", ko: "플람메", role: "Great Mage", color: "#ead08a" },
  { id: "serie", name: "Serie", ko: "제리에", role: "Great Mage", color: "#ead08a" },
  { id: "kanne", name: "Kanne", ko: "칸네", role: "Mage", color: "#f0a070" },
  { id: "lawine", name: "Lawine", ko: "라비네", role: "Mage", color: "#a4c6f4" },
  { id: "wirbel", name: "Wirbel", ko: "비어벨", role: "First-Class Mage", color: "#c0c8d8" },
];
const BY_ID = new Map(ROSTER.map((c) => [c.id, c]));
export const character = (id) => BY_ID.get(id) ?? null;
export const cardPath = (c) => (c ? `mods/journey-party/cards/${c.id}.png` : null);
export const facePath = (c) => (c ? `mods/journey-party/faces/${c.id}.png` : null);

const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

// Tab name → character: jobs.json first, then a tab named after a character gets that character
// ("Fern" tab = Fern; the Korean name in `ko` works too).
// Only own keys are scanned, so names like constructor or __proto__ don't match.
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

// Slots that get a face: tabs with an agent first (screen order), then shell-only tabs, last
// a tab's second and later agents. Keys are tab ids / terminal addresses, so a renamed tab keeps its face.
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

// Assignment: jobs.json and name matches win, faces already given stay, new slots take the next free character.
// Once all 16 are used they repeat. Saved in shared("journey.party"), so it survives restarts.
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

// A shell's command line as words: Herdr tabs run like `& 'claude2' '--resume' ... '--model' 'x'`.
function words(argv) {
  return (argv ?? []).flatMap((a) => String(a).match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));
}

// The account, model and resumed session it started with. null for an agent typed by hand (who.py reads those).
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

// Text for the screen: no control or direction characters, tidy spaces, at most max characters.
const BAD_CHARS = new RegExp("[" + [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]", "g");
export function cleanText(value, max = 80) {
  if (typeof value !== "string") return null;
  const s = value.replace(BAD_CHARS, "").replace(/\s+/g, " ").trim();
  return s === "" ? null : [...s].slice(0, max).join("");
}

// One account in usage.json → what's left of HP (the short window, e.g. 5h) and MP (weekly, else the longest).
// If a failed read kept old numbers and that window has reset since, the value is unknown.
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
