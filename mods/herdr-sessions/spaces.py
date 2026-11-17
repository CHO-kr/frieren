# Which space each session belongs to, for the session panels: they show the shown space's
# sessions, and open a session in its space. Prints {"spaces", "map": {"claude:<id>" | "codex:<id>":
# space name}, "updated"} and writes it to space-map.json.
#
# The spaces come from spaces.json next to the lists (%LOCALAPPDATA%\herdr-sessions\spaces.json):
#   {"spaces": [{"key", "name" (the Herdr space's name), "folder", "about",
#                "words" (a regular expression, case-insensitive), "weight" (how much one word counts)}],
#    "folders": {"<folder>": "<key>"},   a project folder (or a folder above one) -> its space
#    "enough": 8}                        weighted words a space needs before it beats the folder
# Folders may start with "~". Without spaces.json nothing is sorted and the panels list every
# session; spaces.example.json in this folder is a start.
#
# A session goes where its conversation points: the words of what the person asked and the agent
# answered (not tool output), plus its title counted ten times, each times its space's weight (a
# space whose words are rare can weigh more). A known project folder, or the space a Herdr session
# ran in, doubles its space's count; with too few words, the folder decides alone; with neither, the
# session stays unsorted. A right-click in a panel overrides this (shared "sessions.space.assign";
# the panels apply it). Transcripts are read once and then only what was added (space-cache.json
# keeps the counts and where reading stopped; new words start the counts over).

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor

HOME = os.path.expanduser("~")
STORE = os.path.join(os.environ.get("LOCALAPPDATA", HOME), "herdr-sessions")
CONFIG = os.path.join(STORE, "spaces.json")
CACHE = os.path.join(STORE, "space-cache.json")
OUT = os.path.join(STORE, "space-map.json")
WORDS_KEY = "_words"  # in the cache: which words its counts are of


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def expand(path):
    return os.path.normpath(os.path.expanduser(os.path.expandvars(path))) if path else ""


# Read at import, so the workers that count words (processes of their own) have the same words.
SETUP = load(CONFIG) or {}
SPACES = [s for s in SETUP.get("spaces") or [] if isinstance(s, dict) and s.get("key") and s.get("name")]
WORDS = {s["key"]: (float(s.get("weight") or 1), s.get("words") or "") for s in SPACES}
PATTERNS = {k: re.compile(p, re.I) for k, (_, p) in WORDS.items() if p}
ENOUGH = float(SETUP.get("enough") or 8)
SIGNATURE = hashlib.sha1(json.dumps(sorted((k, p) for k, (_, p) in WORDS.items()), ensure_ascii=False).encode()).hexdigest()


def write_atomic(path, text):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def count(text):
    return {k: len(p.findall(text)) for k, p in PATTERNS.items()}


def conversation(kind, line):
    """The person's and the agent's words in one transcript line, or ''."""
    head = line[:1500]
    if kind == "claude":
        if ('"type":"user"' not in head and '"type":"assistant"' not in head) or '"tool_result"' in head:
            return ""
        try:
            c = (json.loads(line).get("message") or {}).get("content")
        except ValueError:
            return ""
        parts = [c] if isinstance(c, str) else [b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if not p.startswith(("<system-reminder>", "<command-", "<local-command")))
    if '"response_item"' not in line[:80] or '"message"' not in head:
        return ""
    try:
        p = json.loads(line).get("payload") or {}
    except ValueError:
        return ""
    if p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
        return ""
    texts = (b.get("text") or "" for b in p.get("content") or [])
    return "\n".join(t for t in texts if not t.startswith(("<environment_context", "<user_instructions", "# AGENTS.md", "<permissions", "<collaboration")))


def scan(job):
    """Counts the words added to a transcript since `offset` (whole lines only)."""
    kind, path, offset, hits = job
    hits = dict(hits or {})
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return path, None
    end = data.rfind(b"\n") + 1
    for raw in data[:end].split(b"\n"):
        if raw:
            text = conversation(kind, raw.decode("utf-8", "replace"))
            if text:
                for k, n in count(text).items():
                    hits[k] = hits.get(k, 0) + n
    return path, {"offset": offset + end, "hits": hits}


def norm(p):
    return os.path.normcase(os.path.normpath((p or "").removeprefix("\\\\?\\"))) if p else ""


def codex_rollouts():
    homes = [os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")]
    accounts = os.path.join(HOME, ".local", "share", "codex-accounts")
    if os.path.isdir(accounts):
        homes += [os.path.join(accounts, d) for d in os.listdir(accounts)]
    found = {}
    for home in homes:
        db = os.path.join(home, "state_5.sqlite")
        if not os.path.isfile(db):
            continue
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
            for tid, rollout in con.execute("select id, rollout_path from threads where rollout_path is not null"):
                found.setdefault(tid, rollout)
            con.close()
        except sqlite3.Error:
            continue
    return found


def sessions():
    """key -> (kind, transcript, title, cwd, space it runs or ran in) for every session the three panels list."""
    rows = {}
    for s in (load(os.path.join(STORE, "claude-list.json"), {}) or {}).get("sessions", []):
        sid = s.get("cli") or s.get("id")
        if sid:
            rows[f"claude:{sid}"] = ("claude", s.get("path"), s.get("title"), s.get("cwd"), None)
    rollouts = {}
    codex = (load(os.path.join(STORE, "codex-list.json"), {}) or {}).get("threads", [])
    herdr = (load(os.path.join(STORE, "herdr-list.json"), {}) or {}).get("sessions", [])
    if codex or any(s.get("kind") == "codex" for s in herdr):
        rollouts = codex_rollouts()
    for s in codex:
        rows.setdefault(f"codex:{s['id']}", ("codex", rollouts.get(s["id"]), s.get("title"), s.get("cwd"), None))
    for s in herdr:
        kind, sid = s.get("kind"), s.get("id")
        if kind in ("claude", "codex") and sid:
            path = s.get("path") if kind == "claude" else rollouts.get(sid)
            old = rows.get(f"{kind}:{sid}") or (None, None, None, None, None)
            where = (s.get("where") or "").split(" / ")[0].strip() or None
            rows[f"{kind}:{sid}"] = (kind, path or old[1], s.get("title") or old[2], s.get("cwd") or old[3], where)
    return rows


def finish(spaces, out):
    data = {"updated": int(time.time() * 1000), "spaces": spaces, "map": out}
    text = json.dumps(data, ensure_ascii=False)
    old = load(OUT)
    if not old or old.get("map") != out or old.get("spaces") != spaces:
        os.makedirs(STORE, exist_ok=True)
        write_atomic(OUT, text)
    sys.stdout.write(text)


def main():
    if not SPACES:
        return finish([], {})  # no spaces.json: nothing to sort into, the panels list everything
    names = {s["key"]: s["name"] for s in SPACES}
    folders = sorted(((norm(expand(f)), k) for f, k in (SETUP.get("folders") or {}).items() if k in names), key=lambda x: -len(x[0]))

    rows = sessions()
    cache = load(CACHE, {}) or {}
    if cache.get(WORDS_KEY) != SIGNATURE:
        cache = {}  # other words: count again from the start
    jobs = []
    for kind, path, _title, _cwd, _where in rows.values():
        if not path or not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        c = cache.get(path)
        if c and c.get("size") == size:
            continue
        if c and size > c.get("size", 0) and c.get("offset", 0) <= size:
            jobs.append((kind, path, c["offset"], c.get("hits")))
        else:
            jobs.append((kind, path, 0, None))
    if jobs or WORDS_KEY not in cache:
        big = sum(1 for j in jobs if j[2] == 0) > 6
        if big:
            with ProcessPoolExecutor(max_workers=min(16, os.cpu_count() or 4)) as pool:
                results = list(pool.map(scan, jobs, chunksize=1))
        else:
            results = [scan(j) for j in jobs]
        for path, res in results:
            if res:
                res["size"] = os.path.getsize(path) if os.path.isfile(path) else 0
                cache[path] = res
        live = {r[1] for r in rows.values() if r[1]}  # drop counts of transcripts no list has any more
        cache = {p: c for p, c in cache.items() if p in live}
        cache[WORDS_KEY] = SIGNATURE
        os.makedirs(STORE, exist_ok=True)
        write_atomic(CACHE, json.dumps(cache, ensure_ascii=False))

    out = {}
    by_name = {v: k for k, v in names.items()}
    for key, (kind, path, title, cwd, ran_in) in rows.items():
        hits = dict((cache.get(path) or {}).get("hits") or {})
        for k, n in count(title or "").items():
            hits[k] = hits.get(k, 0) + 10 * n
        score = {k: hits.get(k, 0) * WORDS[k][0] for k in names}
        where = norm(cwd)
        # A Herdr session started in one of these spaces leans there, before its folder does.
        home = by_name.get(ran_in) or next((k for folder, k in folders if where == folder or where.startswith(folder + os.sep)), None)
        if home:
            score[home] *= 2  # a project folder counts double: setup words (MCP, skills) fill its own work too
        best = max(score, key=score.get) if score else None
        if best and score[best] >= ENOUGH:
            out[key] = names[best]
        elif home:
            out[key] = names[home]
    finish([{"name": s["name"], "folder": expand(s.get("folder")), "about": s.get("about") or ""} for s in SPACES], out)


if __name__ == "__main__":
    main()
