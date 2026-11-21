// Reading an agent's question from its screen (`hc read <terminal>` text). Pure functions only.
//
// Claude Code, a permission prompt (a solid rule on top, maybe a box):
//   ─────────────────────────────
//    Bash command                                  heading
//      git push origin main                        body: the command or file it is about
//    Do you want to proceed?                       question
//    ❯ 1. Yes                                      options, ❯ on the one the terminal has selected
//      2. Yes, and don't ask again for git push commands in C:\repo
//      3. No, and tell Claude what to do differently (esc)
//    Esc to cancel · Tab to amend                  hints (ignored)
// Claude Code's question tool: a tab line (☐ Topic), the question, options with a description under each,
//   "Type something." (free text) and, after a rule, "Chat about this". Multi-select options start with [ ] / [✔].
// Codex: "Would you like to run the following command?", "Reason: …", "$ cmd", then "› 1. Yes, proceed (y)",
//   "2. Yes, and don't ask again for this command (a)", "3. No, and tell Codex what to do differently (esc)".
// Anything else: the last block of numbered options near the bottom and the lines above it.

const RULE = /^\s*[─━═]{8,}\s*$/; // the top of a Claude prompt
const DASH = /^\s*[╌┄┈╍┅┉]{8,}\s*$/; // a dashed rule inside one (around an edit's diff)
const BOX_TOP = /^\s*[╭┌╔]/;
const OPTION = /^(\s*)([❯›▶▸➤→>]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
// A line that asks: where a prompt without a rule starts (Codex)
const ASKS = /^(?:Would you like to|Do you want to|Allow\b|Approve\b)|needs your (?:approval|permission)/i;
// Options that need the person to type: answered in the terminal itself
const FREE = /tell \S+ what to do|type something|type here|chat about this|^other\b|something else|give feedback|let me (?:type|explain)/i;
const CHECK = /^(?:\[([ xX✓✔✗*]?)\]|([☐☑☒◻◼□■]))\s*/;
const HINT = /\s*\(([^()]{1,12})\)\s*$/;
// Live parts of a prompt (a countdown) that don't make it another question
const LIVE = /\b\d+\s*s\b|\bseconds?\b|remaining/i;

const BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
// A screen line without colors, control characters and a box's side borders
function plain(line) {
  return String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(BAD, "")
    .replace(/^(\s*)[│┃║]\s?/, "$1").replace(/\s?[│┃║]\s*$/, "").replace(/\s+$/, "");
}
const len = (s) => [...s].length;
const indent = (s) => s.length - s.trimStart().length;

// The last ~n lines with text, for when no question can be read.
export function tailLines(text, n = 12) {
  const lines = String(text ?? "").split(/\r?\n/).map(plain);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.slice(-n);
}

// { heading, question, body[], options[{ n, label, details[], hint, key, free, checked }], selected, multi,
//   answerable, marker } or null when the bottom of the screen shows no numbered options.
export function readPrompt(text) {
  const lines = String(text ?? "").split(/\r?\n/).map(plain);
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (!end) return null;
  const width = Math.max(...lines.slice(0, end).map(len));

  // the lowest option line: only hints and a description may follow it
  let last = -1;
  for (let i = end - 1; i >= Math.max(0, end - 14); i--) {
    if (OPTION.test(lines[i])) { last = i; break; }
  }
  if (last < 0) return null;
  // up through n-1 … 1, each at most 6 lines above the one below it (descriptions, a rule between them)
  const rows = [{ i: last, m: lines[last].match(OPTION) }];
  let n = Number(rows[0].m[3]);
  for (let i = last - 1; n > 1 && i >= 0 && rows[0].i - i <= 6; i--) {
    const m = lines[i].match(OPTION);
    if (m && Number(m[3]) === n - 1 && indent(lines[i]) <= indent(lines[rows[0].i]) + 2) {
      rows.unshift({ i, m });
      n--;
    }
  }
  if (n !== 1 || rows.length < 2) return null;

  const options = rows.map(({ i, m }, k) => {
    const col = lines[i].indexOf(m[4]);
    let label = m[4];
    // lines under it: the rest of a wrapped label (its first word didn't fit on the line above) or its description
    const lastOne = k + 1 >= rows.length;
    const stop = lastOne ? Math.min(end, i + 4) : rows[k + 1].i;
    const details = [];
    let prev = lines[i];
    for (let j = i + 1; j < stop; j++) {
      const l = lines[j];
      if (!l.trim() || RULE.test(l) || DASH.test(l)) { if (lastOne) break; prev = l; continue; }
      if (lastOne && indent(l) < col - 1) break; // hints under the last option
      if (/^\s*❯?\s*Submit\s*$/.test(l)) continue; // the multi-select submit row
      const word = len(l.trim().split(/\s+/)[0]);
      if (!details.length && len(prev) + 1 + word >= width - 3) label = `${label} ${l.trim()}`;
      else details.push(l.trim());
      prev = l;
    }
    // Codex forms put a description in a column beside the label: "1. Allow      Run the tool and continue"
    const cols = label.split(/\s{2,}/);
    if (cols.length > 1) {
      label = cols[0];
      details.unshift(cols.slice(1).join(" "));
    }
    const hint = label.match(HINT)?.[1]?.trim() ?? null;
    if (hint) label = label.replace(HINT, "");
    const box = label.match(CHECK);
    const checked = box ? Boolean((box[1] ?? "").trim() || box[2] === "☑" || box[2] === "☒" || box[2] === "◼" || box[2] === "■") : null;
    if (box) label = label.slice(box[0].length);
    return {
      n: Number(m[3]),
      label,
      details: details.slice(0, 2),
      hint,
      // a one-letter shortcut the prompt shows, as Codex does: "Yes, proceed (y)"
      shortcut: hint && /^[a-z]$/i.test(hint) ? hint.toLowerCase() : null,
      free: FREE.test(label),
      checked,
      marked: Boolean(m[2]),
      line: i,
    };
  });
  const marked = options.filter((o) => o.marked);
  const multi = options.some((o) => o.checked !== null);
  // a prompt shows its own selection (❯ / ›); a numbered list in the agent's prose has none
  if (marked.length !== 1 && !multi) return null;

  // the prompt's own lines above its options: up to a solid rule or a box's top, at most 30 lines (an edit's diff)
  const top = rows[0].i;
  let start = Math.max(0, top - 16);
  let ruled = false;
  for (let j = top - 1; j >= Math.max(0, top - 30); j--) {
    if (RULE.test(lines[j]) || BOX_TOP.test(lines[j])) { start = j + 1; ruled = true; break; }
  }
  let block = lines.slice(start, top);
  if (!ruled) {
    // no rule (Codex): from its asking line, else the paragraph right above the options
    const q = block.findIndex((l) => ASKS.test(l.trim()));
    if (q >= 0) block = block.slice(q);
    else {
      let k = block.length - 1;
      while (k >= 0 && !block[k].trim()) k--;
      let s = k;
      while (s > 0 && block[s - 1].trim() && k - s < 3) s--;
      block = block.slice(Math.max(0, s), k + 1);
    }
  }
  const said = block.filter((l) => l.trim() && !DASH.test(l)).map((l) => l.trim());
  let heading = null;
  let question = null;
  let body = [];
  let questionFirst = false; // Codex asks first, then shows the reason and the command
  if (said.length === 1) question = said[0];
  else if (said.length > 1) {
    if (ASKS.test(said[0]) && !ASKS.test(said.at(-1))) { question = said[0]; body = said.slice(1); questionFirst = true; }
    else { heading = said[0]; question = said.at(-1); body = said.slice(1, -1); }
  }
  return {
    heading,
    question,
    body,
    questionFirst,
    options: options.map(({ marked: _m, line: _l, ...o }) => o),
    selected: marked.length === 1 ? options.indexOf(marked[0]) : null,
    multi,
    // why keys can't answer it: several can be picked, or the terminal sits on a text box (a digit would be typed)
    why: multi ? "multi" : marked[0].free ? "typing" : null,
    answerable: !multi && !marked[0].free,
    marker: marked[0] ? lines[marked[0].line].trim()[0] : null,
  };
}

// What makes two readings the same question (not which option the terminal has selected, not a countdown).
export function askKey(ask) {
  if (!ask) return null;
  const quiet = (l) => !LIVE.test(l);
  return JSON.stringify([ask.heading, ask.question, ask.body.filter(quiet), ask.options.map((o) => [o.n, o.label, o.hint, o.checked])]);
}
export const sameAsk = (a, b) => Boolean(a && b) && askKey(a) === askKey(b);

// The key that picks an option: Codex's own letter when the prompt shows one, else its number (Claude Code picks on
// a digit at once). Null when it can't be picked with one key (10 and up).
export function keyFor(o, codex) {
  if (!o) return null;
  if (codex && o.shortcut) return o.shortcut;
  return o.n >= 1 && o.n <= 9 ? String(o.n) : null;
}

// A long line cut to fit
export function cut(s, max) {
  const t = [...String(s ?? "")];
  return t.length > max ? t.slice(0, max - 1).join("") + "…" : t.join("");
}
