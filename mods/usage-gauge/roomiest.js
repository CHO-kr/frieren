// Which Claude account and which Codex account to start new work on: the ★ on the chips and the order of the + menu
// (pixel-new-menu reads shared "usage.roomiest"), and how far each window is through its time (the pace tick on a
// chip's bar). Pure functions, tested by `node roomiest.test.mjs`.
//
// The score, per account, in percent of a window:
//   room      what can be used now without hitting any window's limit: 100 minus its fullest window.
//   expiring  use it or lose it: the leftover of a long window (a day or more: weekly, 30d), at most the room, counted
//             more the nearer that window's reset is: none of it 2 days (EXPIRY_HORIZON) or more before the reset,
//             all of it at the reset. A 5-hour window resets all the time, so its leftover doesn't count here.
// An account with at least MIN_EXPIRING expiring and MIN_ROOM room is "spend it first" and beats every other; among
// those the most expiring wins. Otherwise the most room wins. Ties go to the account whose long window resets first,
// then to the one listed first. The room floor keeps a nearly empty account from winning just because it resets.
// Never first: an account whose short window (under a day: the 5-hour one) is BLOCK_SHORT% used or more, or with any
// window at 100%, unless every usable account is like that (then the one with the most room).
// Accounts whose numbers are stale (a failed read), missing, behind a logged-out account or older than MAX_AGE don't
// count at all.

export const MAX_AGE = 30 * 60000;
export const MOST_LEFT_TIP = "Most left: start new work here";
export const MIN_ROOM = 15;
export const MIN_EXPIRING = 10;
export const BLOCK_SHORT = 90;
export const EXPIRY_HORIZON = 2 * 24 * 60; // minutes
// The pace tick: use this many points past the share of the window's time gone counts as ahead of pace.
export const PACE_MARGIN = 5;

const DAY = 24 * 60;
const num = (v) => typeof v === "number" && Number.isFinite(v);

// The windows a chip shows. A window that has reset since a failed read no longer has that use: unknown.
export function shownWindows(a, now) {
  const all = (a?.windows ?? []).map((w) => (a.stale && w.resets != null && w.resets <= now ? { ...w, used: null } : w));
  const weekly = all.filter((w) => w.label === "weekly");
  return a?.agent === "claude" && weekly.length ? weekly : all;
}

// The percent a chip shows (its fullest known window), or null when none is known.
export function shownUse(a, now) {
  const known = shownWindows(a, now).filter((w) => num(w.used));
  return known.length ? known.reduce((m, w) => Math.max(m, w.used), 0) : null;
}

// Fresh, known numbers.
export function usable(a, now, maxAge = MAX_AGE) {
  if (!a || a.stale || a.login_needed) return false;
  if (typeof a.checked !== "number" || now - a.checked > maxAge) return false;
  return shownUse(a, now) != null;
}

// A window's length in minutes: usage.py's `minutes`, else from its label ("5h", "weekly", "30d"); null if unknown.
export function windowMinutes(w) {
  if (num(w?.minutes) && w.minutes > 0) return w.minutes;
  const label = String(w?.label ?? "");
  if (label === "weekly") return 7 * DAY;
  const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(label);
  return m && Number(m[1]) > 0 ? Number(m[1]) * (m[2] === "h" ? 60 : DAY) : null;
}

// "week", "5 hours", "30 days": a window's length in words, for "43% of the week gone".
export function spanName(minutes) {
  if (!num(minutes) || minutes <= 0) return "window";
  if (minutes === 7 * DAY) return "week";
  if (minutes % DAY === 0) return minutes === DAY ? "day" : `${minutes / DAY} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return "window";
}

// How far a window is through its time and whether its use runs ahead of that, or null when its length, reset or use
// isn't known (or the reset has passed). `at` is when the numbers were read, for the rate.
//   elapsed  share of the window's time gone, 0..1 (where the tick goes).
//   ahead    used more than PACE_MARGIN points past that: at this rate it runs out before the reset.
//   runsOut  when, at the rate so far, it reaches 100% (ms; ahead only, never before now).
export function pace(w, now, at = now) {
  const minutes = windowMinutes(w);
  if (!minutes || !num(w?.resets) || w.resets <= now || !num(w?.used)) return null;
  const length = minutes * 60000;
  const start = w.resets - length;
  const elapsed = Math.min(1, Math.max(0, (now - start) / length));
  const ahead = w.used > elapsed * 100 + PACE_MARGIN;
  let runsOut = null;
  if (ahead && w.used < 100) {
    const spent = Math.min(Math.max(at, start), now) - start;
    runsOut = spent > 0 ? Math.max(now, Math.round(start + (spent * 100) / w.used)) : now;
  }
  return { minutes, elapsed, ahead, runsOut };
}

// "45m", "3h", "5d": how long until a reset, for the ★ line.
export function soon(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / DAY)}d`;
}

// One account's numbers for the ranking (see the top), or null when it doesn't count.
export function scoreOf(a, now, maxAge = MAX_AGE) {
  if (typeof a?.name !== "string" || !usable(a, now, maxAge)) return null;
  // A window past its reset time has been reset since the reading: nothing used yet, next reset unknown.
  const windows = (a.windows ?? []).filter((w) => num(w?.used))
    .map((w) => (num(w.resets) && w.resets <= now ? { ...w, used: 0, resets: null } : w))
    .map((w) => ({ ...w, minutes: windowMinutes(w) }));
  const fullest = windows.reduce((m, w) => Math.max(m, w.used), 0);
  const room = Math.max(0, Math.min(100, 100 - fullest));
  const isShort = (w) => w.minutes != null && w.minutes < DAY;
  const blocked = windows.some((w) => w.used >= 100 || (isShort(w) && w.used >= BLOCK_SHORT));
  let expiring = 0;
  let spend = null; // the long window that loses the most
  let soonest = null; // the long window that resets first
  for (const w of windows.filter((w) => !isShort(w) && num(w.resets))) {
    const horizon = Math.min(w.minutes ?? Infinity, EXPIRY_HORIZON) * 60000;
    const near = Math.min(1, Math.max(0, 1 - (w.resets - now) / horizon));
    const lost = Math.min(100 - w.used, room) * near;
    if (lost > expiring) [expiring, spend] = [lost, w];
    if (!soonest || w.resets < soonest.resets) soonest = w;
  }
  const first = !blocked && expiring >= MIN_EXPIRING && room >= MIN_ROOM;
  const unblocks = windows.reduce((m, w) => (num(w.resets) && w.resets < m ? w.resets : m), Infinity);
  return { a, name: a.name, used: shownUse(a, now), room, expiring, first, blocked, spend, soonest, unblocks };
}

// Better first: not blocked; then "spend it first" (most expiring) before the rest (most room); blocked ones by most
// room, then the one that frees up first; then the long window that resets first; then the order given.
function compare(x, y) {
  if (x.blocked !== y.blocked) return x.blocked ? 1 : -1;
  if (x.blocked) {
    if (x.room !== y.room) return y.room - x.room;
    if (x.unblocks !== y.unblocks) return x.unblocks < y.unblocks ? -1 : 1;
  } else {
    if (x.first !== y.first) return x.first ? -1 : 1;
    const by = x.first ? "expiring" : "room";
    if (x[by] !== y[by]) return y[by] - x[by];
  }
  const rx = x.soonest?.resets ?? Infinity;
  const ry = y.soonest?.resets ?? Infinity;
  if (rx !== ry) return rx < ry ? -1 : 1;
  return x.index - y.index;
}

// The one line that says why an account is first (the ★ tooltip, the + menu's row), without the ★.
export function why(s, now) {
  if (!s) return null;
  if (s.first) return `${s.name}: ${Math.round(100 - s.spend.used)}% left resets in ${soon(s.spend.resets - now)} — spend it first`;
  if (!s.blocked) return `${s.name}: most left (${Math.round(s.room)}%)`;
  return `${s.name}: every account is near a limit; most left here (${Math.round(s.room)}%)`;
}

// The + menu's short note for the first account.
const tagOf = (s) => (s.first ? "spend first" : s.blocked ? "near limit" : "most left");

// { claude, codex }: per agent, the usable accounts best first (scoreOf's numbers), so the ★ and the + menu agree.
export function ranking(accounts, now, maxAge = MAX_AGE) {
  const out = { claude: [], codex: [] };
  (accounts ?? []).forEach((a, index) => {
    if (!(a?.agent in out)) return;
    const s = scoreOf(a, now, maxAge);
    if (s) out[a.agent].push({ ...s, index });
  });
  for (const agent of Object.keys(out)) out[agent].sort(compare);
  return out;
}

// { claude, codex }: per agent, the account to start new work on, or null: { name, used, left, why, tag, order }.
// `used` is the percent its chip shows, `left` its room, `why` the one-line reason, `tag` the + menu's note ("spend
// first", "most left", "near limit"), `order` every usable account's name, best first.
export function roomiest(accounts, now, maxAge = MAX_AGE) {
  const ranked = ranking(accounts, now, maxAge);
  const out = { claude: null, codex: null };
  for (const agent of Object.keys(out)) {
    const best = ranked[agent][0];
    if (best) out[agent] = { name: best.name, used: best.used, left: best.room, why: why(best, now), tag: tagOf(best), order: ranked[agent].map((s) => s.name) };
  }
  return out;
}

export const isRoomiest = (best, a) => Boolean(a && best?.[a.agent]?.name === a.name);
