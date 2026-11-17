"""List Claude desktop/CLI sessions as JSON for the claude-sessions mod.

This is the POSIX counterpart of list.ps1.  It deliberately keeps the same
JSON shape so the JavaScript panel does not need platform-specific behavior.
"""

import glob
import json
import os
import re
import subprocess
import sys


HOME = os.path.expanduser("~")


def data_store():
    if os.environ.get("HERDR_SESSIONS_DIR"):
        return os.environ["HERDR_SESSIONS_DIR"]
    if sys.platform == "darwin":
        return os.path.join(HOME, "Library", "Caches", "herdr-sessions")
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(HOME, ".local", "share")), "herdr-sessions")


STORE = data_store()
CACHE_FILE = os.path.join(STORE, "claude-cache.json")
ASSIGNMENT = r"^\s*(?:export\s+)?{name}\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s#;&]+))"


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def assignment(path, name):
    """Read one literal shell/cmd assignment without executing the wrapper."""
    try:
        if os.path.getsize(path) > 256_000:
            return None
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    match = re.search(ASSIGNMENT.format(name=re.escape(name)), text, re.M | re.I)
    if not match:
        # Windows .cmd commonly uses: set "NAME=value"
        match = re.search(r'^\s*@?(?:set\s+)?"?' + re.escape(name) + r"=([^\"\r\n]+)", text, re.M | re.I)
    if not match:
        return None
    raw = next((value for value in match.groups() if value is not None), "").strip()
    raw = raw.replace("%USERPROFILE%", HOME).replace("%HOME%", HOME)
    return os.path.normpath(os.path.expanduser(os.path.expandvars(raw))) if raw else None


def wrappers(prefix, variable):
    """Executable wrappers which actually select an account directory.

    Symlinks are followed: a link to a shell wrapper is useful, while links to
    the real binary and helper programs are skipped because they have no
    matching assignment.
    """
    pattern = os.path.join(HOME, ".local", "bin", prefix + ("*.cmd" if os.name == "nt" else "*"))
    found = []
    for path in sorted(glob.glob(pattern)):
        if os.name != "nt" and not os.access(path, os.X_OK):
            continue
        folder = assignment(path, variable)
        if not folder or not os.path.isdir(folder):
            continue
        name = os.path.basename(path)
        if name.lower().endswith(".cmd"):
            name = name[:-4]
        found.append((name, folder))
    return found


def roots():
    if sys.platform == "darwin":
        candidates = [os.path.join(HOME, "Library", "Application Support", "Claude", "claude-code-sessions")]
    else:
        candidates = [
            os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config")), "Claude", "claude-code-sessions"),
            os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config")), "claude", "claude-code-sessions"),
        ]
    return [path for path in candidates if os.path.isdir(path)]


def session_files(root):
    return glob.glob(os.path.join(root, "*", "*", "local_*.json"))


def cached_sessions(session_roots):
    old = read_json(CACHE_FILE, {}) or {}
    fresh = {}
    for root in session_roots:
        for path in session_files(root):
            try:
                stat = os.stat(path)
            except OSError:
                continue
            stamp = f"{stat.st_mtime_ns}-{stat.st_size}"
            hit = old.get(path)
            if isinstance(hit, dict) and hit.get("stamp") == stamp:
                fresh[path] = hit
                continue
            obj = read_json(path)
            if not isinstance(obj, dict):
                continue
            fresh[path] = {
                "stamp": stamp,
                "id": obj.get("sessionId"),
                "cli": obj.get("cliSessionId"),
                "title": obj.get("title"),
                "cwd": obj.get("cwd"),
                "last": obj.get("lastActivityAt"),
                "created": obj.get("createdAt"),
                "archived": bool(obj.get("isArchived")),
                "turns": obj.get("completedTurns"),
                "model": obj.get("model"),
                "effort": obj.get("effort"),
                "perm": obj.get("permissionMode"),
            }
    if fresh != old:
        os.makedirs(STORE, exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(fresh, f, ensure_ascii=False)
    return fresh


def transcripts():
    out = {}
    for path in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        out[os.path.splitext(os.path.basename(path))[0]] = path
    return out


def running_desktop_sessions():
    """CLI session ids currently hosted by the Claude desktop app."""
    try:
        proc = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True, encoding="utf-8", timeout=8)
    except (OSError, subprocess.SubprocessError):
        return set()
    found = set()
    for command in proc.stdout.splitlines():
        if "Claude" not in command and "claude-code-sessions" not in command and "Claude-Data" not in command:
            continue
        match = re.search(r'--resume(?:=|\s+)["\']?([0-9a-fA-F-]{36})', command)
        if match:
            found.add(match.group(1))
    return found


def linked_sessions(items, jsonl):
    known = {item["cli"]: item for item in items}
    links = (read_json(os.path.join(STORE, "links.json"), {}) or {}).get("links", [])
    for link in links:
        claude = link.get("claude") or {}
        sid = claude.get("session")
        if not sid:
            continue
        pair = {"thread": (link.get("codex") or {}).get("thread"), "title": link.get("title")}
        if sid in known:
            known[sid]["link"] = pair
            continue
        path = claude.get("path") if os.path.isfile(claude.get("path") or "") else jsonl.get(sid)
        if not path and claude.get("config"):
            hits = glob.glob(os.path.join(claude["config"], "projects", "*", sid + ".jsonl"))
            path = hits[0] if hits else None
        if not path:
            continue
        cwd = link.get("cwd")
        item = {
            "id": None, "cli": sid, "title": link.get("title"), "cwd": cwd,
            "last": int(os.path.getmtime(path) * 1000), "created": link.get("created"),
            "archived": False, "turns": None, "model": None, "effort": None, "perm": None,
            "path": path, "resumable": True, "folder": bool(cwd) and os.path.isdir(cwd),
            "desktop": False, "origin": "herdr", "link": pair,
        }
        items.append(item)
        known[sid] = item


def email(path):
    obj = read_json(path, {}) or {}
    value = (obj.get("oauthAccount") or {}).get("emailAddress")
    return value if isinstance(value, str) else None


def model(folder):
    value = (read_json(os.path.join(folder, "settings.json"), {}) or {}).get("model")
    return value if isinstance(value, str) else ""


def accounts():
    main_folder = os.path.join(HOME, ".claude")
    out = [{"name": "claude", "cmd": "claude", "main": True, "email": email(os.path.join(HOME, ".claude.json")),
            "config": main_folder, "model": model(main_folder)}]
    seen = {os.path.normcase(os.path.realpath(main_folder))}
    for name, folder in wrappers("claude", "CLAUDE_CONFIG_DIR"):
        key = os.path.normcase(os.path.realpath(folder))
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "cmd": name, "main": False, "email": email(os.path.join(folder, ".claude.json")),
                    "config": folder, "model": model(folder)})
    return out


def main():
    session_roots = roots()
    fresh = cached_sessions(session_roots)
    jsonl = transcripts()
    desktop = running_desktop_sessions()
    items = []
    for session in fresh.values():
        if not session.get("cli"):
            continue
        item = {key: session.get(key) for key in ("id", "cli", "title", "cwd", "last", "created", "archived", "turns", "model", "effort", "perm")}
        item["path"] = jsonl.get(session["cli"])
        item["resumable"] = item["path"] is not None
        item["folder"] = bool(session.get("cwd")) and os.path.isdir(session["cwd"])
        item["desktop"] = session["cli"] in desktop
        item["origin"] = "desktop"
        items.append(item)
    linked_sessions(items, jsonl)
    items.sort(key=lambda item: item.get("last") or 0, reverse=True)
    result = {"roots": session_roots, "accounts": accounts(), "sessions": items}
    text = json.dumps(result, ensure_ascii=False)
    os.makedirs(STORE, exist_ok=True)
    with open(os.path.join(STORE, "claude-list.json"), "w", encoding="utf-8") as f:
        f.write(text)
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
