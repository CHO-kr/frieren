# The party's scribe: what each agent in a Herdr tab did, read from its own conversation record.
#
# The pixel-chronicle mod runs this every 2 s with the live agent terminals as one JSON argument:
#   {"terms": {"t17g": {"st": "working", "space": "도구", "tab": "fix login", "ch": "Fern"}, ...}}
# It prints, as JSON:
#   terminals  per terminal: its session, how full its context is, the outcomes of its recent commands and edits
#              (a failure is a hit in the battle), its last test run, whether its last turn ended with a question to
#              the person, and the files it made (loot)
#   loot       the newest files made by any agent, newest first
#   events     what happened since the last run (also appended to the journey log)
#   report     once, when the person comes back after AWAY_MS without touching the PC: what happened meanwhile
#   idle       ms since the person last touched mouse or keyboard
#
# Which session a terminal runs comes from the herdr-sessions panel's registry (herdr-made.json, refreshed every
# 30 s by its list.py). Transcripts are read incrementally from a saved offset, so a 50 MB transcript costs only its
# new lines. Claude Code: <config>/projects/*/<session>.jsonl. Codex: the rollout file its thread names in
# state_5.sqlite. Nothing here writes to Claude's or Codex's files.
#
# Files (in %LOCALAPPDATA%\herdr-sessions):
#   chronicle-state.json   offsets and what was learned per transcript, last statuses, the away mark
#   journal.jsonl          the journey log: one event per line, kept to the last JOURNAL_KEEP lines
import ctypes
import glob
import json
import os
import re
import sqlite3
import sys
import time
from ctypes import wintypes
from datetime import datetime

HOME = os.path.expanduser("~")
BIN = os.path.join(HOME, ".local", "bin")
STORE = os.path.join(os.environ.get("LOCALAPPDATA", HOME), "herdr-sessions")
REGISTRY = os.path.join(STORE, "herdr-made.json")
OWN = os.environ.get("CHRONICLE_STORE") or STORE  # tests point this elsewhere
STATE = os.path.join(OWN, "chronicle-state.json")
JOURNAL = os.path.join(OWN, "journal.jsonl")
NOW = int(time.time() * 1000)
VERSION = 3                      # bump when what is learned from a transcript changes: everything is read again

WARM = 2 << 20                   # a transcript seen for the first time: read only its last 2 MB
CHUNK = 6 << 20                  # at most this much new text per transcript per run
SEEN_MS = 120_000                # a registry entry seen this recently is the terminal's current session
AWAY_MS = 15 * 60_000            # this long without input is "away"
BACK_MS = 30_000                 # input this recent after being away is "back"
WOUND_MS = 5 * 60_000            # failures this recent wound a member
QUESTION_MS = 12 * 3600_000      # a question older than this no longer counts
JOURNAL_KEEP = 4000
LOOT_MAX, LOOT_ALL = 12, 40

LOOT_KINDS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"},
    "video": {"mp4", "mov", "webm", "mkv", "avi"},
    "audio": {"mp3", "wav", "m4a", "flac", "ogg", "aac"},
    "doc": {"pdf", "docx", "pptx", "xlsx", "csv", "md", "html"},
}
LOOT_EXT = {e: k for k, es in LOOT_KINDS.items() for e in es}
EXT_RE = "|".join(sorted(LOOT_EXT, key=len, reverse=True))
ABS_PATH = re.compile(r"(?:file:///)?([A-Za-z]:[\\/](?:[^\s\"'<>|*?`()\[\]{},;]+[\\/])*[^\s\"'<>|*?`()\[\]{},;\\/]+\.(?:" + EXT_RE + r"))(?![\w.])", re.I)
REL_PATH = re.compile(r"(?<![\w:\\/.-])((?:\.{1,2}[\\/])?(?:[\w.\-\uac00-\ud7a3]+[\\/])*[\w.\-\uac00-\ud7a3]+\.(?:" + EXT_RE + r"))(?![\w.])", re.I)

# What a shell command does, for its outcome: a test run (its counts are read), a build, a look around (a search
# that finds nothing exits 1: a miss, not a hit), or any other command.
TEST_CMD = re.compile(r"\b(?:pytest|jest|vitest|mocha|unittest|eslint|ruff|mypy|tsc --noEmit|herdr-app check)\b"
                      r"|\b(?:npm|pnpm|yarn|bun)(?: run)? (?:test|lint)\b|\bnode (?:--test|\S+\.test\.m?[jt]s)\b|\b(?:cargo|go|dotnet|deno) test\b", re.I)
# a test file run directly (python x_test.py); a look at one (Get-Content x.test.mjs) is not a test run
TEST_FILE = re.compile(r"\S+\.test\.m?[jt]s\b|\btest_\w+\.py\b|\b\w+_test\.py\b", re.I)
BUILD_CMD = re.compile(r"\b(?:npm|pnpm|yarn|bun)(?: run)? build\b|\b(?:cmake|webpack|vite build|rollup|esbuild|msbuild|gradle|cargo build|dotnet build|make)\b"
                       r"|\brender(?:\.ps1)?\b|\bffmpeg\b", re.I)
LOOK_CMD = re.compile(r"^(?:rg|grep|findstr|Select-String|sls|Get-ChildItem|gci|ls|dir|Test-Path|where(?:\.exe)?|which|Get-Command|gcm"
                      r"|Get-Content|gc|cat|type|head|tail|Get-Item|gi|Resolve-Path|fd|find)\b", re.I)
NOT_LOOT = re.compile(r"\\\.claude[^\\]*\\(?:projects\\[^\\]+\\memory|plans|todos)\\|\\MEMORY\.md$|\\\.codex\\|\\codex-accounts\\", re.I)
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}
QUIET_TOOLS = {"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "Skill"}
SKIPPED = re.compile(r"doesn't want to proceed|was rejected|interrupted by user|user (?:denied|rejected)|Permission to use \S+ has been denied", re.I)


def ms_of(stamp):
    if not stamp:
        return None
    try:
        return int(datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def read_json(path, default):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def cut(s, n=80):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def idle_ms():
    """How long since the last mouse or keyboard input on this desktop."""
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
    try:
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            return None
        return (ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
    except (AttributeError, OSError):
        return None


# ---------- accounts and their context limits --------------------------------------------------

def claude_configs():
    out = {"claude": os.path.join(HOME, ".claude")}
    for path in glob.glob(os.path.join(BIN, "claude*.cmd")):
        try:
            m = re.search(r"CLAUDE_CONFIG_DIR=([^\"\r\n]+)", open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            continue
        if m:
            out[os.path.splitext(os.path.basename(path))[0]] = os.path.expandvars(m.group(1).replace("%USERPROFILE%", HOME))
    return out


def codex_homes():
    out = {"codex": os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")}
    others = os.path.join(HOME, ".local", "share", "codex-accounts")
    for name in os.listdir(others) if os.path.isdir(others) else []:
        out[name] = os.path.join(others, name)
    return out


_settings = {}


def compact_at(config, model):
    """Where Claude Code compacts this model's conversations for this account: the account's
    modelSettings.<model>.autoCompactWindow, else the model's window (1M for the 5.x models, 200k before)."""
    if config not in _settings:
        _settings[config] = read_json(os.path.join(config, "settings.json"), {}) if config else {}
    s = _settings[config]
    m = str(model or "")
    per = (s.get("modelSettings") or {}).get(m) or {}
    if isinstance(per.get("autoCompactWindow"), int):
        return per["autoCompactWindow"]
    if isinstance(s.get("autoCompactWindow"), int):
        return s["autoCompactWindow"]
    if "[1m]" in m or re.search(r"-[5-9]-\d", m):
        return 1_000_000
    return 200_000


# ---------- terminal -> session ----------------------------------------------------------------

def sessions_now(terms, state):
    """terminal -> {key, kind, account, id, path}, for the live terminals given."""
    reg = (read_json(REGISTRY, {}) or {}).get("sessions", {})
    by_term = {}
    for key, e in reg.items():
        t = e.get("terminal")
        if t not in terms or NOW - (e.get("last_seen") or 0) > SEEN_MS:
            continue
        by_term.setdefault(t, []).append((key, e))
    homes = codex_homes()
    rollouts = state.setdefault("rollouts", {})
    out = {}
    for t, entries in by_term.items():
        best = None
        for key, e in entries:
            path = e.get("path") if e.get("kind") == "claude" else rollouts.get(e.get("id"))
            if e.get("kind") == "codex" and not path:
                path = rollout_of(homes.get(e.get("account")), e.get("id"))
                if path:
                    rollouts[e["id"]] = path
            if not path or not os.path.isfile(path):
                continue
            mtime = os.path.getmtime(path)
            if not best or mtime > best[0]:
                best = (mtime, {"key": key, "kind": e.get("kind"), "account": e.get("account"), "id": e.get("id"), "path": path,
                                "cwd": e.get("cwd")})
        if best:
            out[t] = best[1]
    return out


def rollout_of(home, tid):
    if not home or not tid:
        return None
    try:
        con = sqlite3.connect(f"file:{os.path.join(home, 'state_5.sqlite')}?mode=ro", uri=True, timeout=2)
        row = con.execute("select rollout_path, cwd from threads where id = ?", (tid,)).fetchone()
        con.close()
    except sqlite3.Error:
        return None
    return (row[0] or "").removeprefix("\\\\?\\") if row else None


# ---------- what a transcript says ---------------------------------------------------------------

def fresh_facts():
    return {"ctx": None, "outcomes": [], "streak": 0, "tests": None, "question": None, "last_text": "", "busy": False,
            "turn_at": None, "pending": {}, "loot": [], "model": None, "cwd": None, "prompt": None, "full": None}


def ask_of(text):
    """The question a message ends with, if it ends by asking the person something."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", str(text or "").strip()) if p.strip()]
    if not paras:
        return None
    last = paras[-1]
    lines = [l.strip() for l in last.splitlines() if l.strip()]
    tail = lines[-1] if lines else last
    plain = re.sub(r"[*_`>#~]+", "", tail).strip()
    plain = re.sub(r"[\s\u2600-\u27bf\U0001F300-\U0001FAFF]+$", "", plain)
    if re.search(r"[?？]\)?$", plain) or re.search(
            r"(?:알려\s?주세요|말씀해\s?주세요|골라\s?주세요|선택해\s?주세요|정해\s?주세요|답해\s?주세요|let me know|which (?:one|option) (?:do|would) you)[.!]?$",
            plain, re.I):
        # the sentence that asks: from the last sentence break before the end
        parts = re.split(r"(?<=[.!。])\s+", plain)
        return cut(parts[-1] if parts else plain, 140)
    return None


def test_counts(text):
    t = str(text or "")
    passed = [int(x) for x in re.findall(r"(\d+)\s+(?:tests?\s+)?(?:passed|passing|pass)\b", t, re.I)]
    passed += [int(x) for x in re.findall(r"#\s*pass\s+(\d+)", t)]
    failed = [int(x) for x in re.findall(r"(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?)\b", t, re.I)]
    failed += [int(x) for x in re.findall(r"#\s*fail\s+(\d+)", t)]
    return (max(passed) if passed else None), (max(failed) if failed else None)


def what_of(cmd):
    c = re.sub(r"^(?:\$\s*|cd [^;&]+(?:&&|;)\s*)", "", str(cmd or "").strip())
    if TEST_CMD.search(c):
        return "test"
    if LOOK_CMD.search(c):
        return "look"
    if BUILD_CMD.search(c):
        return "build"
    if TEST_FILE.search(c):
        return "test"
    return "command"


def loot_kind(path):
    return LOOT_EXT.get(os.path.splitext(path)[1].lower().lstrip("."))


def find_paths(text, cwd):
    """Paths of result files named in a command, its output or a message (JSON-escaped backslashes undone)."""
    s = re.sub(r"\\{2,}", r"\\", str(text or ""))
    out = []
    for m in ABS_PATH.finditer(s):
        out.append(os.path.normpath(m.group(1).replace("/", "\\")))
    if cwd:
        for m in REL_PATH.finditer(s):
            p = m.group(1)
            if re.match(r"[A-Za-z]:", p):
                continue
            out.append(os.path.normpath(os.path.join(cwd, p)))
    return [p for p in out if not NOT_LOOT.search(p)]


class Reader:
    """Folds new transcript lines into a file's facts; collects journal events (unless warming up)."""

    def __init__(self, facts, quiet, emit):
        self.f = facts
        self.quiet = quiet
        self.emit = emit

    def outcome(self, at, ok, what, detail, text=None):
        o = {"at": at, "ok": bool(ok), "what": what, "detail": cut(detail, 70)}
        if what == "test":
            p, fl = test_counts(text)
            if p is not None:
                o["passed"] = p
            if fl is not None:
                o["failed"] = fl
            if fl and o["ok"]:
                o["ok"] = False
            self.f["tests"] = {k: o[k] for k in ("at", "ok", "passed", "failed", "detail") if k in o}
            if not self.quiet:
                n = f" ({o.get('passed', 0)} passed" + (f", {o['failed']} failed" if o.get("failed") else "") + ")" if "passed" in o or o.get("failed") else ""
                self.emit({"at": at, "kind": "tests", "ok": o["ok"], "text": f"{'ALL CLEAR' if o['ok'] else 'WOUNDED'}: the check {'passed' if o['ok'] else 'failed'}{n} · {o['detail']}"})
        if what in ("test", "build", "command", "edit"):
            if o["ok"]:
                self.f["streak"] = 0
            else:
                self.f["streak"] = self.f.get("streak", 0) + 1
                if self.f["streak"] == 3 and not self.quiet:
                    self.emit({"at": at, "kind": "rage", "ok": False, "text": f"3 failures in a row · {o['detail']}"})
                elif what == "build" and not self.quiet:
                    self.emit({"at": at, "kind": "fail", "ok": False, "text": f"Build failed · {o['detail']}"})
        self.f["outcomes"] = (self.f["outcomes"] + [o])[-12:]

    def loot(self, at, paths, since=None):
        have = {x["path"].lower() for x in self.f["loot"]}
        for p in paths:
            p = os.path.normpath(p)
            k = loot_kind(p)
            if not k or p.lower() in have or NOT_LOOT.search(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            # only files written lately (a path named in passing is often an old one)
            if st.st_mtime * 1000 < (since or at or NOW) - 15 * 60_000:
                continue
            item = {"path": p, "at": at or NOW, "kind": k}
            self.f["loot"] = ([item] + self.f["loot"])[:LOOT_MAX]
            have.add(p.lower())
            if not self.quiet:
                self.emit({"at": at or NOW, "kind": "loot", "ok": True, "text": f"Loot dropped: {os.path.basename(p)}", "path": p})

    def turn_start(self, at, prompt):
        self.f["busy"] = True
        self.f["turn_at"] = at
        self.f["question"] = None
        self.f["prompt"] = cut(prompt, 90) if prompt else self.f.get("prompt")
        if not self.quiet and prompt:
            self.emit({"at": at, "kind": "start", "ok": True, "text": cut(prompt, 90)})

    def turn_end(self, at, text, asked=None):
        was = self.f.get("busy")
        self.f["busy"] = False
        q = asked or ask_of(text)
        self.f["question"] = {"text": q, "at": at} if q else None
        self.f["last_text"] = cut(text, 160)
        if was and not self.quiet:
            if q:
                self.emit({"at": at, "kind": "question", "ok": True, "text": q})
            else:
                self.emit({"at": at, "kind": "done", "ok": True, "text": cut(text, 110) or "Quest complete"})

    def prune(self):
        p = self.f["pending"]
        if len(p) > 150:
            for k in sorted(p, key=lambda k: p[k].get("at") or 0)[: len(p) - 100]:
                p.pop(k, None)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") in ("text", "input_text", "output_text"))
    return ""


def read_claude(r, line, config):
    try:
        o = json.loads(line)
    except ValueError:
        return
    typ = o.get("type")
    if o.get("isSidechain"):
        return
    at = ms_of(o.get("timestamp")) or NOW
    f = r.f
    if o.get("cwd"):
        f["cwd"] = o["cwd"]
    if typ == "assistant":
        m = o.get("message") or {}
        u = m.get("usage") or {}
        used = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        if used and m.get("model") and not str(m.get("model")).startswith("<"):
            f["model"] = m["model"]
            f["ctx"] = {"used": used, "at": at}
            f["full"] = compact_at(config, m["model"])
        texts = []
        for c in m.get("content") or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text" and c.get("text", "").strip():
                texts.append(c["text"])
            elif c.get("type") == "tool_use":
                inp = c.get("input") or {}
                f["pending"][c.get("id")] = {"name": c.get("name"), "at": at, "cmd": cut(inp.get("command") or inp.get("description") or "", 200),
                                             "path": inp.get("file_path") or inp.get("notebook_path")}
        if texts:
            f["last_text"] = cut(texts[-1], 4000)
        if m.get("stop_reason") == "end_turn":
            r.turn_end(at, texts[-1] if texts else f.get("last_text"))
    elif typ == "user":
        m = o.get("message") or {}
        content = m.get("content")
        if isinstance(content, str) or (isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "text" for c in content)):
            prompt = text_of(content).strip()
            if o.get("isCompactSummary") or prompt.startswith("This session is being continued from a previous conversation"):
                pass
            elif prompt and not prompt.startswith("<") and not o.get("isMeta") and "[Request interrupted" not in prompt:
                r.turn_start(at, prompt)
            elif "[Request interrupted" in prompt:
                r.turn_end(at, "")
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict) or c.get("type") != "tool_result":
                continue
            call = f["pending"].pop(c.get("tool_use_id"), None) or {}
            name = call.get("name") or ""
            out = text_of(c.get("content"))
            if SKIPPED.search(out[:300]):
                continue
            ok = not c.get("is_error")
            if name in SHELL_TOOLS:
                r.outcome(at, ok, what_of(call.get("cmd")), call.get("cmd") or name, out[-3000:])
                if ok:
                    r.loot(at, find_paths(call.get("cmd"), f.get("cwd")) + find_paths(out[-4000:], f.get("cwd")), f.get("turn_at"))
            elif name in EDIT_TOOLS:
                r.outcome(at, ok, "edit", os.path.basename(call.get("path") or "") or name)
                if ok and name == "Write" and call.get("path"):
                    r.loot(at, [call["path"]], f.get("turn_at"))
            elif name and name not in QUIET_TOOLS and not ok:
                r.outcome(at, ok, "tool", name)
        r.prune()
    elif typ == "system" and o.get("subtype") == "compact_boundary":
        meta = o.get("compactMetadata") or {}
        post = meta.get("postTokens")
        if post:
            f["ctx"] = {"used": int(post), "at": at}
        if not r.quiet:
            r.emit({"at": at, "kind": "inn", "ok": True, "text": f"Rested at the inn: the conversation was summarized ({cut(meta.get('trigger'), 10)})"})


CMD_IN_JS = re.compile(r"exec_command\(\{\s*cmd\s*:\s*(`(?:[^`\\]|\\.)*`|\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')")
EXIT_CODE = re.compile(r"exit_code\\*\"?\s*:\s*(-?\d+)|Exit code:\s*(-?\d+)|Process exited with code (-?\d+)")


def read_codex(r, line):
    try:
        o = json.loads(line)
    except ValueError:
        return
    p = o.get("payload") or {}
    typ, kind = o.get("type"), p.get("type")
    at = ms_of(o.get("timestamp")) or NOW
    f = r.f
    if typ == "turn_context" and p.get("cwd"):
        f["cwd"] = p["cwd"]
        if p.get("model"):
            f["model"] = p["model"]
    if typ == "event_msg":
        if kind == "token_count":
            info = p.get("info") or {}
            last = info.get("last_token_usage") or {}
            used = int(last.get("total_tokens") or 0)
            if used:
                f["ctx"] = {"used": used, "at": at}
            if info.get("model_context_window"):
                f["full"] = int(info["model_context_window"])
        elif kind == "task_started":
            if p.get("model_context_window"):
                f["full"] = int(p["model_context_window"])
            f["busy"] = True
            f["turn_at"] = at
            f["question"] = None
        elif kind == "user_message":
            msg = p.get("message") or ""
            if msg and not msg.lstrip().startswith("<"):
                r.turn_start(at, msg)
        elif kind == "task_complete":
            r.turn_end(at, p.get("last_agent_message") or f.get("last_text"), f.pop("asked", None))
        elif kind == "turn_aborted":
            f["busy"] = False
        elif kind == "agent_message" and p.get("message"):
            f["last_text"] = cut(p["message"], 4000)
        elif kind == "exec_command_end":
            cmd = " ".join(p.get("command") or []) if isinstance(p.get("command"), list) else str(p.get("command") or "")
            code = p.get("exit_code")
            r.outcome(at, code == 0, what_of(cmd), cmd, (p.get("aggregated_output") or p.get("stdout") or "")[-3000:])
        elif kind == "patch_apply_end":
            files = list((p.get("changes") or {}).keys())
            r.outcome(at, bool(p.get("success")), "edit", os.path.basename(files[0]) if files else "patch")
    elif typ == "response_item":
        if kind in ("custom_tool_call", "function_call"):
            name = p.get("name") or ""
            src = p.get("input") if kind == "custom_tool_call" else p.get("arguments")
            src = src if isinstance(src, str) else json.dumps(src or "", ensure_ascii=False)
            cmds = []
            if name == "exec":
                for m in CMD_IN_JS.finditer(src):
                    raw = m.group(1)[1:-1]
                    cmds.append(raw.replace("\\\\", "\\").replace('\\"', '"').replace("\\n", " "))
            elif name in ("shell", "exec_command", "local_shell"):
                try:
                    a = json.loads(src)
                    c = a.get("cmd") or a.get("command")
                    cmds.append(" ".join(c) if isinstance(c, list) else str(c or ""))
                except ValueError:
                    pass
            elif name == "request_user_input_async":
                try:
                    qs = json.loads(src).get("questions") or []
                    if qs:
                        f["asked"] = cut(qs[0].get("title") or qs[0].get("question") or "", 140)
                except (ValueError, AttributeError):
                    pass
            patch = "apply_patch" in src
            f["pending"][p.get("call_id")] = {"name": name, "at": at, "cmds": [cut(c, 200) for c in cmds], "patch": patch}
        elif kind in ("custom_tool_call_output", "function_call_output"):
            call = f["pending"].pop(p.get("call_id"), None)
            if not call:
                return
            out = p.get("output")
            text = text_of(out) if isinstance(out, list) else str(out or "")
            codes = [int(next(g for g in m.groups() if g is not None)) for m in EXIT_CODE.finditer(text)]
            failed = re.search(r"^(?:Script failed|Uncaught|Error: )", text.strip()[:200], re.M)
            cmds = call.get("cmds") or []
            if cmds or codes:
                bad = [i for i, c in enumerate(codes) if c != 0]
                ok = not bad and not failed
                cmd = cmds[bad[0]] if bad and bad[0] < len(cmds) else (cmds[0] if cmds else call.get("name"))
                tests = [c for c in cmds if what_of(c) == "test"]
                what = "test" if tests else what_of(cmd)
                r.outcome(at, ok, what, tests[0] if tests else cmd, text[-3000:])
                if ok:
                    r.loot(at, find_paths(" ".join(cmds), f.get("cwd")) + find_paths(text[-4000:], f.get("cwd")), f.get("turn_at"))
            elif call.get("patch"):
                r.outcome(at, not failed, "edit", "patch")
        elif kind == "message" and p.get("role") == "assistant":
            t = text_of(p.get("content"))
            if t.strip():
                f["last_text"] = cut(t, 4000)
                r.loot(at, find_paths(t, f.get("cwd")), f.get("turn_at"))
    r.prune()


def advance(entry, files, configs, emit):
    """Reads what's new in one transcript; returns its facts."""
    path = entry["path"]
    rec = files.get(path)
    try:
        size = os.path.getsize(path)
    except OSError:
        return rec["facts"] if rec else None
    quiet = False
    if not rec or rec.get("v") != VERSION or size < rec.get("off", 0):
        rec = {"v": VERSION, "off": max(0, size - WARM), "facts": fresh_facts(), "kind": entry["kind"]}
        quiet = True
    files[path] = rec
    if size == rec["off"]:
        return rec["facts"]
    with open(path, "rb") as fh:
        fh.seek(rec["off"])
        data = fh.read(min(CHUNK, size - rec["off"]))
    start = 0
    if quiet and rec["off"] > 0:
        nl = data.find(b"\n")
        start = nl + 1 if nl >= 0 else len(data)
    end = data.rfind(b"\n")
    if end < start:
        return rec["facts"]
    facts = rec["facts"]
    facts["cwd"] = facts.get("cwd") or entry.get("cwd")
    r = Reader(facts, quiet, emit)
    config = configs.get(entry.get("account")) if entry["kind"] == "claude" else None
    for raw in data[start:end].split(b"\n"):
        if not raw.strip():
            continue
        line = raw.decode("utf-8", "replace")
        if entry["kind"] == "claude":
            read_claude(r, line, config)
        else:
            read_codex(r, line)
    rec["off"] += end + 1
    return facts


def summary(t, entry, facts):
    ctx = facts.get("ctx")
    full = facts.get("full")
    context = None
    if ctx and full:
        context = {"used": ctx["used"], "full": full, "pct": max(0, min(100, round(100 * ctx["used"] / full)))}
    outs = facts.get("outcomes") or []
    hurts = lambda o: not o["ok"] and o["what"] in ("test", "build", "command", "edit")
    wounds = [o for o in outs if hurts(o) and NOW - o["at"] < WOUND_MS]
    q = facts.get("question")
    return {
        "kind": entry["kind"], "account": entry.get("account"), "session": entry.get("id"), "path": entry["path"],
        "model": facts.get("model"), "context": context, "busy": bool(facts.get("busy")),
        "question": q if q and NOW - q["at"] < QUESTION_MS else None,
        "outcomes": outs[-8:], "streak": facts.get("streak", 0), "wounds": len(wounds),
        "hit": next(({"at": o["at"], "what": o["what"], "detail": o["detail"]} for o in reversed(outs) if hurts(o)), None),
        "tests": facts.get("tests"), "loot": facts.get("loot") or [], "prompt": facts.get("prompt"),
    }


def append_journal(events):
    if not events:
        return
    try:
        with open(JOURNAL, "a", encoding="utf-8") as fh:
            for e in events:
                fh.write(json.dumps(e, ensure_ascii=False) + "\n")
        if os.path.getsize(JOURNAL) > 3 << 20:
            with open(JOURNAL, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            write_atomic(JOURNAL, "".join(lines[-JOURNAL_KEEP:]))
    except OSError:
        pass


def main():
    try:
        given = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except ValueError:
        given = {}
    terms = given.get("terms") or {}
    state = read_json(STATE, {})
    if state.get("version") != 1:
        state = {"version": 1}
    files = state.setdefault("files", {})
    last = state.setdefault("status", {})
    recent = state.setdefault("recent", [])
    configs = claude_configs()
    events = []

    current = sessions_now(terms, state)
    out_terms = {}
    for t, entry in current.items():
        info = terms.get(t) or {}
        who = {"t": t, "space": info.get("space"), "tab": info.get("tab"), "ch": info.get("ch"), "account": entry.get("account")}
        facts = advance(entry, files, configs, lambda e, who=who: events.append({**e, **who}))
        if facts is not None:
            out_terms[t] = summary(t, entry, facts)
    # a member who calls for help (Herdr's own status: the transcript doesn't record a pending question)
    for t, info in terms.items():
        st = info.get("st")
        if st == "blocked" and last.get(t) != "blocked":
            events.append({"at": NOW, "kind": "help", "ok": False, "text": "Called for help", "t": t, "space": info.get("space"),
                           "tab": info.get("tab"), "ch": info.get("ch"), "account": (current.get(t) or {}).get("account")})
        last[t] = st
    for t in list(last):
        if t not in terms:
            last.pop(t)
    # forget transcripts nobody has shown for a day
    live = {e["path"] for e in current.values()}
    for p in list(files):
        if p not in live and NOW - files[p].get("seen", NOW) > 86_400_000:
            files.pop(p)
    for p in live:
        if p in files:
            files[p]["seen"] = NOW

    events.sort(key=lambda e: e["at"])
    append_journal(events)
    recent.extend(events)
    del recent[: max(0, len(recent) - 600)]

    # away and back
    idle = idle_ms()
    report = None
    if idle is not None:
        if idle >= AWAY_MS and not state.get("away"):
            state["away"] = NOW - idle
        elif idle < BACK_MS and state.get("away"):
            since = state.pop("away")
            got = [e for e in recent if e["at"] >= since and e["kind"] != "start"]
            if got:
                report = {"since": since, "until": NOW, "events": got[-80:]}

    loot = sorted(({**x, "terminal": t} for t, s in out_terms.items() for x in s["loot"]), key=lambda x: -x["at"])[:LOOT_ALL]
    state["updated"] = NOW
    try:
        write_atomic(STATE, json.dumps(state, ensure_ascii=False))
    except OSError:
        pass
    sys.stdout.write(json.dumps({"at": NOW, "idle": idle, "terminals": out_terms, "loot": loot, "events": events, "report": report},
                                ensure_ascii=False))


if __name__ == "__main__":
    main()
