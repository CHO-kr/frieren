# Lists the Codex app's threads (ChatGPT/Codex desktop) as JSON for the codex-sessions mod.
# Reads state_5.sqlite read-only; a held thread-writer lock means some process has the thread open.
import base64
import json
import msvcrt
import os
import re
import sqlite3
import sys

home = os.environ.get("CODEX_HOME") or os.path.expanduser(r"~\.codex")

# Strongest first, to pick a model an account can use when the thread's own isn't offered to it.
PREFERENCE = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]


def account(name, path, main):
    """An account's login email, the models its plan lists, and the model to use by default."""
    email = None
    try:
        token = json.load(open(os.path.join(path, "auth.json"), encoding="utf-8"))["tokens"]["id_token"]
        payload = token.split(".")[1]
        email = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("email")
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        pass
    try:
        cache = json.load(open(os.path.join(path, "models_cache.json"), encoding="utf-8"))
        models = [m["slug"] for m in cache["models"] if m.get("visibility") == "list"]
    except (OSError, ValueError, KeyError):
        models = []
    default = None
    try:
        top = open(os.path.join(path, "config.toml"), encoding="utf-8").read().split("\n[")[0]
        found = re.search(r'^\s*model\s*=\s*"([^"]+)"', top, re.M)
        default = found and found.group(1)
    except OSError:
        pass
    best = default if default in models else next((m for m in PREFERENCE if m in models), default)
    return {"name": name, "cmd": name, "main": main, "email": email, "models": models, "best": best}


# This account, and each ~/.local/share/codex-accounts/<name> with its ~/.local/bin/<name>.cmd.
accounts = [account("codex", home, True)]
others = os.path.expanduser(r"~\.local\share\codex-accounts")
for name in sorted(os.listdir(others)) if os.path.isdir(others) else []:
    if os.path.isfile(os.path.expanduser(rf"~\.local\bin\{name}.cmd")):
        accounts.append(account(name, os.path.join(others, name), False))


def strip(path):
    return path[4:] if path and path.startswith("\\\\?\\") else path


def held(lock):
    try:
        with open(lock, "r+b") as f:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        return False
    except OSError:
        return True


def one_line(text):
    return " ".join((text or "").split())


try:
    state = json.load(open(os.path.join(home, ".codex-global-state.json"), encoding="utf-8"))
except (OSError, ValueError):
    state = {}
pins = state.get("pinned-thread-ids") or []

con = sqlite3.connect(f"file:{os.path.join(home, 'state_5.sqlite')}?mode=ro", uri=True)
rows = con.execute(
    """select id, name, title, preview, cwd, recency_at_ms, updated_at_ms, model, reasoning_effort,
              approval_mode, sandbox_policy, originator, is_pinned
       from threads
       where archived = 0 and source in ('cli', 'vscode') and (thread_source is null or thread_source = 'user')"""
).fetchall()

locks = os.path.join(home, "thread-writer-locks")
threads = []
for (tid, name, title, preview, cwd, recency, updated, model, effort, approval, sandbox, originator, is_pinned) in rows:
    try:
        sandbox_type = json.loads(sandbox).get("type")
    except (TypeError, ValueError):
        sandbox_type = None
    cwd = strip(cwd)
    lock = os.path.join(locks, f"{tid}.lock")
    threads.append({
        "id": tid,
        "title": one_line(name) or one_line(title) or one_line(preview),
        "cwd": cwd,
        "last": recency or updated,
        "model": model,
        "effort": effort,
        "approval": approval,
        "sandbox": sandbox_type,
        "originator": originator,
        "pin": pins.index(tid) if tid in pins else (len(pins) if is_pinned else None),
        "folder": bool(cwd) and os.path.isdir(cwd),
        "open": os.path.exists(lock) and held(lock),
    })
# Pairs with Claude sessions (session-menu\bridge.py).
try:
    with open(os.path.join(os.environ.get("LOCALAPPDATA", ""), "herdr-sessions", "links.json"), encoding="utf-8") as f:
        pairs = {(l.get("codex") or {}).get("thread"): l for l in json.load(f).get("links", [])}
except (OSError, ValueError):
    pairs = {}
for t in threads:
    pair = pairs.get(t["id"])
    t["link"] = pair and {"session": (pair.get("claude") or {}).get("session"), "title": pair.get("title")}
threads.sort(key=lambda t: t["last"] or 0, reverse=True)
text = json.dumps({"home": home, "accounts": accounts, "threads": threads}, ensure_ascii=False)
# The session-search mod reads the last list from here.
store = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "herdr-sessions")
os.makedirs(store, exist_ok=True)
with open(os.path.join(store, "codex-list.json"), "w", encoding="utf-8") as f:
    f.write(text)
sys.stdout.write(text)
