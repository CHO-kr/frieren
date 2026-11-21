# Which space each session belongs to, for the session panels: they show the shown space's
# sessions, and open a session in its space. Prints {"spaces", "map": {"claude:<id>" | "codex:<id>":
# space name}, "all", "updated"} and writes it to space-map.json.
#
# The spaces come from spaces.json next to the lists (%LOCALAPPDATA%\herdr-sessions\spaces.json):
#   {"spaces": [{"key", "name" (the Herdr space's name), "folder", "about",
#                "words" (a regular expression, case-insensitive), "weight" (how much one word counts)}],
#    "folders": {"<folder>": "<key>"},   a project folder (or a folder above one) -> its space
#    "enough": 8,                        weighted words a space needs before it beats the folder
#    "all": "All"}                       optional: a Herdr space that sorts nothing and, shown, lists
#                                        every space's sessions in one list (passed on as "all")
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
#
# Codex compresses older transcripts (rollout-….jsonl.zst). Reading those needs the zstandard
# package (pip install zstandard); without it they are skipped and such threads are sorted by
# their title and folder only.

import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor

try:
    import zstandard
except ImportError:
    zstandard = None

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
ALL = SETUP.get("all") if isinstance(SETUP.get("all"), str) and SETUP.get("all").strip() else None
if ALL in {s["name"] for s in SPACES}:
    ALL = None  # a space that sorts sessions can't also be the one listing them all
READING = 3  # how transcripts are read; a change counts every transcript again
SIGNATURE = hashlib.sha1(json.dumps([READING, sorted((k, p) for k, (_, p) in WORDS.items())], ensure_ascii=False).encode()).hexdigest()

# Codex wraps what it adds to a thread itself (page contents, plugin lists, skills, notifications,
# heartbeats) in a tag, and what a person types doesn't start with one. These tagged ones are said:
# answers to the agent's questions, spoken and handed-over requests, messages from other agents.
SAID_IN_TAGS = ("<send_user_message_question_reply", "<realtime_delegation", "<codex_delegation", "<hc ")
ADDED = ("# AGENTS.md", "# In app browser:", "<heartbeat")


def said(role, text):
    t = text.lstrip()
    if t.startswith(ADDED):
        return False
    return role != "user" or not t.startswith("<") or t.startswith(SAID_IN_TAGS)


def write_atomic(path, text):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def count(text):
    return {k: len(p.findall(text)) for k, p in PATTERNS.items()}


def parse(raw):
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return {}


def conversation(kind, raw):
    """The person's and the agent's words in one transcript line (bytes), or ''. Only lines that
    look like messages are parsed: transcripts run to gigabytes, mostly tool output."""
    head = raw[:6000].decode("utf-8", "replace")[:1500]  # the first 1500 characters
    if kind == "claude":
        if ('"type":"user"' not in head and '"type":"assistant"' not in head) or '"tool_result"' in head:
            return ""
        c = (parse(raw).get("message") or {}).get("content")
        parts = [c] if isinstance(c, str) else [b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if not p.startswith(("<system-reminder>", "<command-", "<local-command")))
    if '"response_item"' not in head[:80] or '"message"' not in head:
        return ""
    p = parse(raw).get("payload") or {}
    if p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
        return ""
    texts = (b.get("text") or "" for b in p.get("content") or [] if isinstance(b, dict))
    return "\n".join(t for t in texts if said(p["role"], t))


def add(hits, kind, raw):
    text = conversation(kind, raw)
    if text:
        for k, n in count(text).items():
            hits[k] = hits.get(k, 0) + n


def scan(job):
    """Counts the words added to a transcript since `offset`, a line at a time (a last line still
    being written waits for the next run). A compressed one is finished: it is read whole, and its
    offset is its size."""
    kind, path, offset, hits = job
    hits = dict(hits or {})
    if path.endswith(".zst"):
        if not zstandard:
            return path, None
        try:
            with open(path, "rb") as f:
                stream = zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True)
                for raw in io.BufferedReader(stream, 1 << 20):
                    add(hits, kind, raw)
        except (OSError, zstandard.ZstdError):
            return path, None
        return path, {"offset": os.path.getsize(path), "hits": hits}
    end = offset
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            for raw in f:
                if not raw.endswith(b"\n"):
                    break
                end += len(raw)
                add(hits, kind, raw)
    except OSError:
        return path, None
    return path, {"offset": end, "hits": hits}


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
                found.setdefault(tid, on_disk(rollout))
            con.close()
        except sqlite3.Error:
            continue
    return found


def on_disk(rollout):
    """Where a Codex transcript is now: as recorded, or compressed next to it."""
    if rollout and not os.path.isfile(rollout) and os.path.isfile(rollout + ".zst"):
        return rollout + ".zst"
    return rollout


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
    data = {"updated": int(time.time() * 1000), "spaces": spaces, "map": out, "all": ALL}
    text = json.dumps(data, ensure_ascii=False)
    old = load(OUT)
    if not old or old.get("map") != out or old.get("spaces") != spaces or old.get("all") != ALL:
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
        if path.endswith(".zst") and not zstandard:
            continue
        if c and not path.endswith(".zst") and size > c.get("size", 0) and c.get("offset", 0) <= size:
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
