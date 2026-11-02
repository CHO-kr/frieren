# Carries one piece of work between Claude Code and Codex so that each side keeps a single
# session that grows. The first move makes the other side's session (Codex's own importer for
# Claude -> Codex, a new Claude session with a fixed id for Codex -> Claude) and remembers the
# pair. Later moves reopen that same session and hand it only what happened on this side since
# the last move: a document its first message points to.
#   python -X utf8 bridge.py to-codex <claude-session.jsonl> <cwd> <title>
#   python -X utf8 bridge.py to-claude <codex-thread-id> <claude-config-dir>
# Prints {"mode": "new" | "resume", ...} as JSON. Pairs live in %LOCALAPPDATA%\herdr-sessions\links.json.
import datetime
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

STORE = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "herdr-sessions")
LINKS = os.path.join(STORE, "links.json")
HANDOFF = os.path.join(STORE, "handoff")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.expanduser(r"~\.codex")
LIMIT = 120_000  # characters handed over at once (~40-60k tokens); the newest part wins
NOW = int(time.time() * 1000)


def load_links():
    try:
        with open(LINKS, encoding="utf-8") as f:
            return json.load(f).get("links", [])
    except (OSError, ValueError):
        return []


def save_links(links):
    os.makedirs(STORE, exist_ok=True)
    with open(LINKS + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"links": links}, f, ensure_ascii=False, indent=1)
    os.replace(LINKS + ".tmp", LINKS)


def short(text, n):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def command(text):
    """The command itself, without the shell that ran it ("...pwsh.exe" -NoProfile -Command '...')."""
    if isinstance(text, list):
        text = " ".join(map(str, text))
    text = re.sub(r'^"[^"]*"\s+(-NoProfile\s+)?(-Command\s+)?', "", str(text).strip())
    return text[1:-1] if len(text) > 1 and text[0] == text[-1] == "'" else text


class Turns:
    """Messages in order; tools used between two messages become one short note."""

    def __init__(self):
        self.turns = []
        self.tally = {"commands": [], "files": [], "tools": [], "searches": []}

    def flush(self):
        t, notes = self.tally, []
        if t["commands"]:
            notes.append(f"명령 {len(t['commands'])}개 실행 (마지막: `{short(command(t['commands'][-1]), 120)}`)")
        if t["files"]:
            files = list(dict.fromkeys(f for f in t["files"] if f))
            notes.append("파일 수정: " + ", ".join(f"`{f}`" for f in files[:8]) + (f" 외 {len(files) - 8}개" if len(files) > 8 else ""))
        if t["tools"]:
            notes.append("도구: " + ", ".join(list(dict.fromkeys(t["tools"]))[:6]))
        if t["searches"]:
            notes.append("웹 검색: " + "; ".join(short(q, 60) for q in t["searches"][:3]))
        for v in t.values():
            v.clear()
        if notes:
            self.turns.append(("note", " · ".join(notes)))

    def say(self, role, text):
        text = (text or "").strip()
        if text:
            self.flush()
            self.turns.append((role, text))

    def done(self):
        self.flush()
        return self.turns


def write_doc(name, heading, meta, turns, agent):
    """A Markdown hand-off; past LIMIT it keeps the first request and the newest turns."""
    dropped = 0
    if sum(len(t) for _, t in turns) > LIMIT:
        head = turns[0] if turns[0][0] == "user" else None
        kept, used = [], len(head[1]) if head else 0
        for turn in reversed(turns[1:] if head else turns):
            if used + len(turn[1]) > LIMIT:
                break
            kept.append(turn)
            used += len(turn[1])
        kept.reverse()
        dropped = len(turns) - len(kept) - (1 if head else 0)
        turns = ([head] if head else []) + [("gap", f"중간 기록 {dropped}개는 길어서 생략했습니다.")] + kept
    lines = [f"# {heading}", "", *meta, ""]
    previous = None
    for role, text in turns:
        if role == "note":
            lines += [f"> 작업 기록: {text}", ""]
        elif role == "gap":
            lines += [f"> … {text}", ""]
        else:
            if role != previous:
                lines += ["## 사용자" if role == "user" else f"## {agent}", ""]
            lines += [text, ""]
        previous = role if role in ("user", "agent") else previous
    os.makedirs(HANDOFF, exist_ok=True)
    path = os.path.join(HANDOFF, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# ---- Codex ----

def strip(path):
    return path[4:] if path and path.startswith("\\\\?\\") else path


def codex_db(name):
    return sqlite3.connect(f"file:{os.path.join(CODEX_HOME, name)}?mode=ro", uri=True)


def codex_thread(tid):
    row = codex_db("state_5.sqlite").execute(
        "select coalesce(name, ''), title, cwd, history_mode, rollout_path, model from threads where id = ?", (tid,)).fetchone()
    if not row:
        return None
    name, first, cwd, mode, rollout, model = row
    return {"id": tid, "title": " ".join((name or first or tid).split())[:80], "cwd": strip(cwd),
            "mode": mode, "rollout": strip(rollout), "model": model}


def codex_items(thread):
    """(position, kind, data): paginated history rows, or a legacy rollout's lines."""
    if thread["mode"] != "legacy":
        for pos, kind, data in codex_db("thread_history_1.sqlite").execute(
                "select rollout_ordinal, item_type, item_json from thread_items where thread_id = ? order by rollout_ordinal",
                (thread["id"],)):
            yield pos, kind, json.loads(data)
        return
    with open(thread["rollout"], encoding="utf-8") as f:
        for pos, line in enumerate(f):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            p = entry.get("payload") or {}
            if entry.get("type") != "event_msg":
                yield pos, None, None
                continue
            kind = p.get("type")
            if kind == "user_message":
                yield pos, "userMessage", {"content": [{"type": "text", "text": p.get("message", "")}]}
            elif kind == "agent_message":
                yield pos, "agentMessage", {"text": p.get("message", "")}
            elif kind == "exec_command_begin":
                yield pos, "commandExecution", {"command": p.get("command", "")}
            elif kind == "patch_apply_begin":
                yield pos, "fileChange", {"changes": [{"path": k} for k in (p.get("changes") or {})]}
            else:
                yield pos, None, None


def codex_turns(thread, since):
    """Turns after position `since`, and the last position seen."""
    out, last = Turns(), since
    for pos, kind, data in codex_items(thread):
        last = max(last, pos)
        if pos <= since or kind is None:
            continue
        if kind == "userMessage":
            parts = [c.get("text", "") if c.get("type") == "text" else "[이미지 첨부]" for c in data.get("content", [])]
            out.say("user", "\n".join(p for p in parts if p))
        elif kind == "agentMessage":
            out.say("agent", data.get("text", ""))
        elif kind == "commandExecution":
            out.tally["commands"].append(data.get("command", ""))
        elif kind == "fileChange":
            out.tally["files"].extend(c.get("path", "") for c in data.get("changes", []))
        elif kind == "mcpToolCall":
            out.tally["tools"].append(f"{data.get('server')}.{data.get('tool')}")
        elif kind == "webSearch":
            out.tally["searches"].append(data.get("query", ""))
    return out.done(), last


def codex_import(path, cwd, title):
    """Codex's own importer (the one the Codex desktop app uses) turns a Claude transcript into a thread."""
    exes = sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe")), key=os.path.getmtime, reverse=True)
    if not exes:
        sys.exit("codex.exe not found under %LOCALAPPDATA%\\OpenAI\\Codex\\bin")
    proc = subprocess.Popen([exes[0], "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, cwd=cwd, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    watchdog = threading.Timer(180, proc.kill)
    watchdog.daemon = True
    watchdog.start()

    def send(msg):
        proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def until(match):
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "error" in msg and msg.get("id") is not None:
                sys.exit(f"app-server error: {msg['error']}")
            if match(msg):
                return msg
        sys.exit("app-server closed before the import finished")

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "herdr-sessions", "version": "0.1"}}})
        until(lambda m: m.get("id") == 1)
        send({"method": "initialized"})
        item = {"itemType": "SESSIONS", "description": title or os.path.basename(path), "cwd": cwd,
                "details": {"sessions": [{"cwd": cwd, "path": path, "title": title}]}}
        send({"id": 2, "method": "externalAgentConfig/import", "params": {"migrationItems": [item]}})
        import_id = until(lambda m: m.get("id") == 2)["result"]["importId"]
        done = until(lambda m: m.get("method") == "externalAgentConfig/import/completed" and m["params"].get("importId") == import_id)
    finally:
        proc.kill()
    results = [r for r in done["params"]["itemTypeResults"] if r["itemType"] == "SESSIONS"]
    wins = [s for r in results for s in r["successes"]]
    if not wins:
        sys.exit("import failed: " + ("; ".join(f["message"] for r in results for f in r["failures"]) or "no session imported"))
    return wins[0].get("target")


# ---- Claude ----

NOISE = ("<local-command", "<command-", "<system-reminder", "<task-notification")


def claude_turns(path, since):
    """Turns after line `since` of a Claude transcript, and its line count."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    out = Turns()
    for line in lines[since:]:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("isSidechain") or e.get("isMeta"):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if e.get("type") == "user":
            blocks = [content] if isinstance(content, str) else [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
            out.say("user", "\n".join(b for b in blocks if b.strip() and not b.lstrip().startswith(NOISE)))
        elif e.get("type") == "assistant":
            for b in content or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    out.say("agent", b.get("text", ""))
                elif b.get("type") == "tool_use":
                    name, args = b.get("name", ""), b.get("input") or {}
                    if name in ("Bash", "PowerShell"):
                        out.tally["commands"].append(args.get("command", ""))
                    elif name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                        out.tally["files"].append(args.get("file_path") or args.get("notebook_path"))
                    elif name == "WebSearch":
                        out.tally["searches"].append(args.get("query", ""))
                    elif name:
                        out.tally["tools"].append(name)
    return out.done(), len(lines)


def claude_path(link):
    """Where the pair's Claude transcript is now (a new session's file appears once it starts)."""
    c = link.get("claude") or {}
    if c.get("path") and os.path.isfile(c["path"]):
        return c["path"]
    folders = [c.get("config"), os.path.expanduser(r"~\.claude")] + glob.glob(os.path.expanduser(r"~\.claude-*"))
    for folder in filter(None, folders):
        found = glob.glob(os.path.join(folder, "projects", "*", f"{c.get('session')}.jsonl"))
        if found:
            return found[0]
    return None


def stamp():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


# ---- moves ----

def to_codex(path, cwd, title):
    session = os.path.splitext(os.path.basename(path))[0]
    links = load_links()
    link = next((l for l in links if (l.get("claude") or {}).get("session") == session), None)
    thread = codex_thread(link["codex"]["thread"]) if link and link.get("codex") else None
    if thread:
        turns, end = claude_turns(path, link["claude"].get("synced", 0))
        out = {"mode": "resume", "thread": thread["id"], "cwd": thread["cwd"] or cwd, "title": link["title"]}
        if turns:
            link["moves"] = link.get("moves", 0) + 1
            out["doc"] = write_doc(f"{link['id']}-{link['moves']:02d}-claude-to-codex.md", f"Claude에서 이어서 한 작업: {link['title']}",
                                   [f"- Claude 세션: `{session}` · 넘긴 때 {stamp()}",
                                    "- 지난번에 Codex에서 넘어간 뒤 Claude에서 한 대화입니다. 도구 사용은 요약만 남겼습니다."], turns, "Claude")
            out["prompt"] = (f"그동안 Claude에서 이 작업을 이어서 했어. Claude 쪽 작업 기록은 {out['doc']} 에 있어. "
                             "읽고 무엇이 바뀌었는지 짧게 정리한 다음, 내 다음 지시를 기다려 줘.")
        link["claude"].update(synced=end, path=path)
        link["updated"] = NOW
    else:
        tid = codex_import(path, cwd, title)
        _, end = codex_turns(codex_thread(tid), -1)
        with open(path, encoding="utf-8") as f:
            lines = sum(1 for _ in f)
        config = os.path.dirname(os.path.dirname(os.path.dirname(path)))
        if link:
            links.remove(link)
        link = {"id": uuid.uuid4().hex[:8], "title": title, "cwd": cwd, "moves": 0, "created": NOW, "updated": NOW,
                "claude": {"session": session, "config": config, "path": path, "synced": lines},
                "codex": {"thread": tid, "synced": end}}
        links.append(link)
        out = {"mode": "new", "thread": tid, "cwd": cwd, "title": title}
    save_links(links)
    return out


def to_claude(tid, config):
    thread = codex_thread(tid)
    if not thread:
        sys.exit(f"no Codex thread {tid}")
    links = load_links()
    link = next((l for l in links if (l.get("codex") or {}).get("thread") == tid), None)
    path = claude_path(link) if link else None
    if path:
        turns, end = codex_turns(thread, link["codex"].get("synced", -1))
        out = {"mode": "resume", "session": link["claude"]["session"], "path": path, "cwd": thread["cwd"], "title": link["title"]}
        if turns:
            link["moves"] = link.get("moves", 0) + 1
            out["doc"] = write_doc(f"{link['id']}-{link['moves']:02d}-codex-to-claude.md", f"Codex에서 이어서 한 작업: {link['title']}",
                                   [f"- Codex 작업: `{tid}` (모델 {thread['model'] or '?'}) · 넘긴 때 {stamp()}",
                                    "- 지난번에 Claude에서 넘어간 뒤 Codex에서 한 대화입니다. 도구 사용은 요약만 남겼습니다."], turns, "Codex")
            out["prompt"] = (f"그동안 Codex에서 이 작업을 이어서 했어. Codex 쪽 작업 기록은 {out['doc']} 에 있어. "
                             "읽고 무엇이 바뀌었는지 짧게 정리한 다음, 내 다음 지시를 기다려 줘.")
        link["codex"]["synced"] = end
        link["claude"]["path"] = path
        link["updated"] = NOW
    else:
        turns, end = codex_turns(thread, -1)
        if not turns:
            sys.exit("이 Codex 작업에는 옮길 대화가 없어요.")
        session = str(uuid.uuid4())
        if link:
            links.remove(link)
        link = {"id": uuid.uuid4().hex[:8], "title": thread["title"], "cwd": thread["cwd"], "moves": 0, "created": NOW, "updated": NOW,
                "claude": {"session": session, "config": config, "path": None, "synced": 0},
                "codex": {"thread": tid, "synced": end}}
        links.append(link)
        doc = write_doc(f"{link['id']}-00-codex.md", f"Codex 작업 기록: {thread['title']}",
                        [f"- Codex 작업: `{tid}` (모델 {thread['model'] or '?'}) · 넘긴 때 {stamp()}",
                         f"- 작업 폴더: `{thread['cwd']}`",
                         "- Codex에서 하던 대화를 그대로 옮긴 기록입니다. 도구 사용은 요약만 남겼습니다."], turns, "Codex")
        out = {"mode": "new", "session": session, "cwd": thread["cwd"], "title": thread["title"], "doc": doc,
               "prompt": (f"Codex에서 하던 작업 «{thread['title']}»을 이어서 맡아 줘. 지금까지의 대화 기록은 {doc} 에 있어. "
                          "먼저 읽고 어디까지 됐는지 짧게 정리한 다음, 내 다음 지시를 기다려 줘.")}
    save_links(links)
    return out


if __name__ == "__main__":
    verb, args = sys.argv[1], sys.argv[2:]
    result = to_codex(*args) if verb == "to-codex" else to_claude(*args)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
