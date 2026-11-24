# The right-click menu's "Delete": one Claude session or Codex thread, after the person confirmed.
#
#   python forget.py claude <session id>
#   python forget.py codex <thread id> <codex home>
#
# Claude: every account's transcript (<id>.jsonl) and its <id>\ folder (sub-agents, tool output),
#         file-history\<id>, session-env\<id>, todos\<id>*, and the desktop app's local_*.json
#         record that names it. They go to the Recycle Bin, so a mistake can be undone there.
# Codex:  `codex delete --force` (Codex's own delete: its database row and transcript, for good),
#         for the thread and the sub-agent threads it spawned.
# It refuses while the session may be open: a Claude process still on it, a held Codex lock, or
# a transcript written to in the last 2 minutes (the menu also refuses one open in a Herdr tab or
# the desktop app).
# Working folders stay: other sessions may share them.
# Prints {"kind", "removed": [what went], "where": "recycle bin" | "codex"}; a refusal or failure
# exits 1 with one line on stderr, which the menu shows.
import ctypes
import glob
import json
import msvcrt
import os
import re
import sqlite3
import subprocess
import sys
import time
from ctypes import wintypes

HOME = os.path.expanduser("~")
BIN = os.path.join(HOME, ".local", "bin")
ID = re.compile(r"^[0-9a-fA-F-]{8,64}$")


def fail(text):
    sys.stderr.write(text + "\n")
    sys.exit(1)


# ---------- Claude ---------------------------------------------------------------------------

def claude_configs():
    """~/.claude and each claude*.cmd's CLAUDE_CONFIG_DIR (as herdr-sessions/list.py reads them)."""
    out = [os.path.join(HOME, ".claude")]
    for path in sorted(glob.glob(os.path.join(BIN, "claude*.cmd"))):
        try:
            m = re.search(r"CLAUDE_CONFIG_DIR=([^\"\r\n]+)", open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            continue
        if m:
            out.append(os.path.expandvars(m.group(1).replace("%USERPROFILE%", HOME)))
    return [c for c in dict.fromkeys(out) if os.path.isdir(c)]


def process(pid):
    """(image name, start ms) of a running process, or None."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            return None
        buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
        name = os.path.basename(buf.value).lower() if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)) else ""
        times = [wintypes.FILETIME() for _ in range(4)]
        start = None
        if k32.GetProcessTimes(h, *(ctypes.byref(t) for t in times)):
            start = ((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime) // 10000 - 11644473600000
        return name, start
    finally:
        k32.CloseHandle(h)


def claude_open(sid, configs):
    """A running Claude process whose session file names this session. Claude's updater renames
    a running claude.exe to claude.exe.old.<time>.<pid>, so the name only has to start with
    "claude"; a process started when the session file says counts whatever its name."""
    for c in configs:
        for p in glob.glob(os.path.join(c, "sessions", "*.json")):
            try:
                s = json.load(open(p, encoding="utf-8"))
                pid = int(os.path.splitext(os.path.basename(p))[0])
            except (OSError, ValueError):
                continue
            if s.get("sessionId") != sid:
                continue
            proc = process(pid)
            if not proc:
                continue
            name, start = proc
            began = s.get("startedAt")
            if name.startswith("claude") or (start and isinstance(began, (int, float)) and abs(start - began) < 300_000):
                return pid
    return None


RECENT = 120  # seconds: a transcript written to this recently may still be open somewhere


def fresh(paths):
    now = time.time()
    return [p for p in paths if os.path.isfile(p) and now - os.path.getmtime(p) < RECENT]


def desktop_records(sid):
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Claude-Data")
    out = []
    for p in glob.glob(os.path.join(root, "claude_*", "claude-code-sessions", "*", "*", "local_*.json")):
        try:
            if json.load(open(p, encoding="utf-8")).get("cliSessionId") == sid:
                out.append(p)
        except (OSError, ValueError):
            continue
    return out


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]


def recycle(paths):
    """Sends files and folders to the Recycle Bin, quietly. Returns the ones that are gone."""
    if not paths:
        return []
    op = SHFILEOPSTRUCTW()
    op.wFunc = 3  # FO_DELETE
    op.pFrom = "\0".join(os.path.abspath(p) for p in paths) + "\0\0"
    op.fFlags = 0x40 | 0x10 | 0x4 | 0x400  # ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
    ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return [p for p in paths if not os.path.exists(p)]


def forget_claude(sid):
    configs = claude_configs()
    pid = claude_open(sid, configs)
    if pid:
        fail(f"Still open (claude.exe {pid} is writing it). Close it first.")
    found = []
    for c in configs:
        for t in glob.glob(os.path.join(c, "projects", "*", f"{sid}.jsonl")):
            found.append(t)
            if os.path.isdir(t[:-6]):
                found.append(t[:-6])
        for sub in ("file-history", "session-env", "tasks"):
            if os.path.isdir(os.path.join(c, sub, sid)):
                found.append(os.path.join(c, sub, sid))
        found += glob.glob(os.path.join(c, "todos", f"{sid}*.json"))
    found += desktop_records(sid)
    if not any(p.endswith(".jsonl") or os.path.basename(p).startswith("local_") for p in found):
        fail("Nothing to delete: no transcript or desktop record for it on this PC.")
    if fresh([p for p in found if p.endswith(".jsonl")]):
        fail("It was written to in the last 2 minutes, so it may still be open. Close it, then try again.")
    gone = recycle(found)
    left = [p for p in found if p not in gone]
    if left:
        fail(f"Couldn't move {len(left)} of {len(found)} items to the Recycle Bin: {left[0]}")
    return {"kind": "claude", "removed": gone, "where": "recycle bin"}


# ---------- Codex ----------------------------------------------------------------------------

def held(lock):
    try:
        with open(lock, "r+b") as f:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        return False
    except OSError:
        return True


def codex_db(home):
    return sqlite3.connect(f"file:{os.path.join(home, 'state_5.sqlite')}?mode=ro", uri=True)


def spawned(home, tid):
    """The thread and every sub-agent thread under it, children first."""
    with codex_db(home) as con:
        edges = con.execute("select parent_thread_id, child_thread_id from thread_spawn_edges").fetchall()
    kids = {}
    for parent, child in edges:
        kids.setdefault(parent, []).append(child)
    out, todo, seen = [], [tid], set()
    while todo:
        t = todo.pop()
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
        todo += kids.get(t, [])
    return out[::-1]


def thread_known(home, tid):
    with codex_db(home) as con:
        return con.execute("select rollout_path from threads where id = ?", (tid,)).fetchone()


def forget_codex(tid, home):
    if not os.path.isfile(os.path.join(home, "state_5.sqlite")):
        fail(f"No Codex databases in {home}")
    if not thread_known(home, tid):
        fail("Nothing to delete: Codex doesn't know this task any more.")
    ids = spawned(home, tid)
    for t in ids:
        lock = os.path.join(home, "thread-writer-locks", f"{t}.lock")
        if os.path.isfile(lock) and held(lock):
            fail("Still open in Codex (the desktop app or a terminal). Close it first."
                 if t == tid else "One of its sub-agents is still open in Codex. Close it first.")
        row = thread_known(home, t)
        if row and row[0] and fresh([row[0]]):
            fail("It was written to in the last 2 minutes, so it may still be open. Close it, then try again.")
    main = os.path.normcase(os.path.abspath(home)) == os.path.normcase(os.path.abspath(
        os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")))
    env = dict(os.environ)
    if not main or os.environ.get("CODEX_HOME"):
        env["CODEX_HOME"] = home
    cmd = os.path.join(BIN, "codex.cmd")
    removed = []
    for t in ids:
        if not thread_known(home, t):
            continue
        # The main account goes through Codex's shared service, which tells the desktop app; the
        # others run on their own (--no-daemon), as their .cmd files do.
        argv = ["cmd", "/d", "/c", cmd, *([] if main else ["--no-daemon"]), "delete", "--force", t]
        r = subprocess.run(argv, env=env, capture_output=True, timeout=120, creationflags=0x08000000)
        if thread_known(home, t):
            said = (r.stderr or r.stdout).decode("utf-8", "replace").strip().splitlines()
            fail(f"codex delete failed for {t}: {said[-1] if said else f'exit {r.returncode}'}")
        removed.append(t)
    return {"kind": "codex", "removed": removed, "where": "codex"}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("claude", "codex") or not ID.match(sys.argv[2]):
        fail("usage: forget.py claude <session id> | codex <thread id> <codex home>")
    kind, sid = sys.argv[1], sys.argv[2]
    if kind == "claude":
        out = forget_claude(sid)
    else:
        if len(sys.argv) < 4:
            fail("forget.py codex needs the Codex home")
        out = forget_codex(sid, sys.argv[3])
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
