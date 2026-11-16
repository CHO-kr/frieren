// Which Claude account and which Codex account have the most usage left: the "Most left" marker on the chips and the
// order of the + menu (pixel-new-menu reads shared "usage.roomiest"). Pure functions, tested by `node roomiest.test.mjs`.
// An account's use is the percent its chip shows: a Claude account its weekly window (else its windows), a Codex
// account the fullest of its windows. Accounts whose numbers are stale (a failed read), missing, behind a logged-out
// account or older than MAX_AGE don't count.

export const MAX_AGE = 30 * 60000;
export const MOST_LEFT_TIP = "Most left: start new work here";

// The windows a chip shows. A window that has reset since a failed read no longer has that use: unknown.
export function shownWindows(a, now) {
  const all = (a?.windows ?? []).map((w) => (a.stale && w.resets != null && w.resets <= now ? { ...w, used: null } : w));
  const weekly = all.filter((w) => w.label === "weekly");
  return a?.agent === "claude" && weekly.length ? weekly : all;
}

// The percent a chip shows (its fullest known window), or null when none is known.
export function shownUse(a, now) {
  const known = shownWindows(a, now).filter((w) => typeof w.used === "number" && Number.isFinite(w.used));
  return known.length ? known.reduce((m, w) => Math.max(m, w.used), 0) : null;
}

// Fresh, known numbers.
export function usable(a, now, maxAge = MAX_AGE) {
  if (!a || a.stale || a.login_needed) return false;
  if (typeof a.checked !== "number" || now - a.checked > maxAge) return false;
  return shownUse(a, now) != null;
}

// { claude, codex }: per agent, { name, used } of the usable account with the lowest shown use, or null. A tie goes
// to the one with less use in any window (a Claude account's 5-hour one too), then to the one listed first.
export function roomiest(accounts, now, maxAge = MAX_AGE) {
  const out = { claude: null, codex: null };
  for (const agent of Object.keys(out)) {
    let best = null;
    for (const a of accounts ?? []) {
      if (a?.agent !== agent || typeof a.name !== "string" || !usable(a, now, maxAge)) continue;
      const any = (a.windows ?? []).reduce((m, w) => (typeof w.used === "number" ? Math.max(m, w.used) : m), 0);
      const score = [shownUse(a, now), any];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { a, score };
    }
    out[agent] = best ? { name: best.a.name, used: best.score[0] } : null;
  }
  return out;
}

export const isRoomiest = (best, a) => Boolean(a && best?.[a.agent]?.name === a.name);
