# Claude and Codex sessions started in Herdr tabs, as JSON for the herdr-sessions mod.
#
# Every run (the panel calls it every 30 s) looks at the live terminals Herdr shows (labelled
# herdr.space) and the processes under them:
#   claude.exe  -> <config>/sessions/<pid>.json names its session (claude, claude2, claude3)
#   codex.exe   -> the thread-writer lock it holds names its thread (codex, codex2..codex5);
#                  Windows Restart Manager says which process holds each lock. When Codex runs
#                  on its shared daemon, the daemon holds the lock instead, and the thread is
#                  matched to the tab by folder and the title Codex gives the tab.
# What it finds is kept in %LOCALAPPDATA%\herdr-sessions\herdr-made.json, so a session stays
# listed after its tab is closed. Nothing here writes to Claude's or Codex's own files.
#
# Where a session belongs (its "root", decided once):
#   desktop  the Claude or Codex desktop app made it, or it was forked from one of theirs
#            (or from a session their panels list). Forks go to derived.json, which the Claude
#            and Codex sessions panels add to their own lists.
#   outside  made elsewhere (another terminal) before this tab's program started, then reopened
#            here. It goes to the Claude or Codex sessions panel too.
#   herdr    started new in Herdr, or forked from such a session. Only these show here.
# A fork names its parent in the tab's command (claude --resume X --fork-session, codex fork X)
# or, for Codex, in the thread's own record (forked_from_id).
import ctypes
import glob
import json
import msvcrt
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from ctypes import wintypes
from datetime import datetime

HOME = os.path.expanduser("~")
BIN = os.path.join(HOME, ".local", "bin")
STORE = os.path.join(os.environ.get("LOCALAPPDATA", HOME), "herdr-sessions")
REGISTRY = os.path.join(STORE, "herdr-made.json")
NOW = int(time.time() * 1000)


# ---------- accounts -------------------------------------------------------------------------

def claude_accounts():
    out = [{"name": "claude", "cmd": "claude", "main": True, "config": os.path.join(HOME, ".claude")}]
    for path in sorted(glob.glob(os.path.join(BIN, "claude*.cmd"))):
        try:
            m = re.search(r"CLAUDE_CONFIG_DIR=([^\"\r\n]+)", open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            continue
        if m:
            name = os.path.splitext(os.path.basename(path))[0]
            out.append({"name": name, "cmd": name, "main": False, "config": os.path.expandvars(m.group(1).replace("%USERPROFILE%", HOME))})
    return out


def codex_accounts():
    out = [{"name": "codex", "cmd": "codex", "main": True, "home": os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")}]
    others = os.path.join(HOME, ".local", "share", "codex-accounts")
    for name in sorted(os.listdir(others)) if os.path.isdir(others) else []:
        if os.path.isfile(os.path.join(BIN, f"{name}.cmd")):
            out.append({"name": name, "cmd": name, "main": False, "home": os.path.join(others, name)})
    return out


# ---------- live Herdr terminals and their processes -----------------------------------------

def hc_path():
    return shutil.which("hc") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "herdr-core", "hc.exe")


def hc_json(args):
    try:
        r = subprocess.run([hc_path(), *args], capture_output=True, timeout=10, creationflags=0x08000000)
        return json.loads(r.stdout.decode("utf-8", "replace")) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def herdr_terminals():
    listed = hc_json(["ls", "--json"]) or {}
    out = []
    for t in listed.get("terminals", []):
        if t.get("state") != "live":
            continue
        info = hc_json(["get", t["address"]])
        if not info or not (info.get("labels") or {}).get("herdr.space"):
            continue
        out.append(info)
    return out


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


def processes():
    """pid -> (parent pid, exe name), from one snapshot."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    out = {}
    if snap in (None, wintypes.HANDLE(-1).value):
        return out
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            out[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile.lower())
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return out


def started_ms(pid):
    """When a process started (ms since 1970), or None."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(h, *(ctypes.byref(t) for t in times)):
            return None
        ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return ticks // 10000 - 11644473600000
    finally:
        k32.CloseHandle(h)


def descendants(root, procs):
    kids = {}
    for pid, (ppid, _) in procs.items():
        if pid != ppid:
            kids.setdefault(ppid, []).append(pid)
    seen, todo = set(), [root]
    while todo:
        for c in kids.get(todo.pop(), []):
            if c not in seen:
                seen.add(c)
                todo.append(c)
    return seen


# ---------- which process holds a file (Restart Manager) -------------------------------------

class RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [("dwProcessId", wintypes.DWORD), ("ProcessStartTime", wintypes.FILETIME)]


class RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [("Process", RM_UNIQUE_PROCESS), ("strAppName", ctypes.c_wchar * 256),
                ("strServiceShortName", ctypes.c_wchar * 64), ("ApplicationType", ctypes.c_int),
                ("AppStatus", wintypes.ULONG), ("TSSessionId", wintypes.DWORD), ("bRestartable", wintypes.BOOL)]


def holders(path):
    rm = ctypes.WinDLL("rstrtmgr")
    h = wintypes.DWORD()
    if rm.RmStartSession(ctypes.byref(h), 0, ctypes.create_unicode_buffer(64)) != 0:
        return set()
    try:
        if rm.RmRegisterResources(h, 1, (ctypes.c_wchar_p * 1)(path), 0, None, 0, None) != 0:
            return set()
        needed, count, reasons = wintypes.UINT(0), wintypes.UINT(16), wintypes.DWORD(0)
        infos = (RM_PROCESS_INFO * 16)()
        if rm.RmGetList(h, ctypes.byref(needed), ctypes.byref(count), infos, ctypes.byref(reasons)) not in (0, 234):
            return set()
        return {infos[i].Process.dwProcessId for i in range(count.value)}
    finally:
        rm.RmEndSession(h)


def held(lock):
    try:
        with open(lock, "r+b") as f:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        return False
    except OSError:
        return True


# ---------- reading Claude transcripts and Codex threads -------------------------------------

def tail_lines(path, size=2 << 20):
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        f.seek(max(0, end - size))
        return f.read().decode("utf-8", "replace").splitlines()


def head_lines(path, size=256 << 10):
    with open(path, "rb") as f:
        return f.read(size).decode("utf-8", "replace").splitlines()


def claude_facts(path):
    """Title (renamed, else Claude's own), permission mode and first prompt of a transcript."""
    title = ai = perm = first = None
    for part in (tail_lines(path), head_lines(path)):
        for line in reversed(part):
            if '"custom-title"' in line and not title:
                try: title = json.loads(line).get("customTitle")
                except ValueError: pass
            elif '"ai-title"' in line and not ai:
                try: ai = json.loads(line).get("aiTitle")
                except ValueError: pass
            elif '"permission-mode"' in line and not perm:
                try: perm = json.loads(line).get("permissionMode")
                except ValueError: pass
        if (title or ai) and perm:
            break
    head = head_lines(path)
    origin = next((m.group(1) for m in (re.search(r'"entrypoint":"([^"]+)"', l) for l in head) if m), None)
    # when the conversation began: its first record's time
    created = None
    for line in head:
        found = re.search(r'"timestamp":"([^"]+)"', line)
        if found:
            try:
                created = int(datetime.fromisoformat(found.group(1).replace("Z", "+00:00")).timestamp() * 1000)
            except ValueError:
                pass
            break
    for line in head:
        if '"type":"user"' in line:
            try:
                msg = json.loads(line).get("message", {}).get("content")
            except ValueError:
                continue
            text = msg if isinstance(msg, str) else " ".join(c.get("text", "") for c in msg or [] if isinstance(c, dict) and c.get("type") == "text")
            text = " ".join(text.split())
            if text and not text.startswith("<"):
                first = text[:80]
                break
    return {"title": title or ai, "perm": perm, "first": first, "origin": origin, "created": created}


def codex_threads(home, ids):
    if not ids:
        return {}
    try:
        con = sqlite3.connect(f"file:{os.path.join(home, 'state_5.sqlite')}?mode=ro", uri=True, timeout=2)
        marks = ",".join("?" * len(ids))
        rows = con.execute(
            f"""select id, name, title, preview, cwd, recency_at_ms, updated_at_ms, model, reasoning_effort, approval_mode,
                       sandbox_policy, archived, source, thread_source, rollout_path, originator, created_at_ms
                from threads where id in ({marks})""", list(ids)).fetchall()
        con.close()
    except sqlite3.Error:
        return {}
    out = {}
    for (tid, name, title, preview, cwd, recency, updated, model, effort, approval, sandbox, archived, source, tsource, rollout, originator, created) in rows:
        try:
            sandbox = json.loads(sandbox).get("type")
        except (TypeError, ValueError):
            sandbox = None
        one = lambda s: " ".join((s or "").split())
        out[tid] = {"title": one(name) or one(title) or one(preview), "cwd": (cwd or "").removeprefix("\\\\?\\"),
                    "last": recency or updated, "model": model, "effort": effort, "approval": approval, "sandbox": sandbox,
                    "archived": bool(archived), "cli": source == "cli", "user": tsource in (None, "user"),
                    "originator": originator, "created": created,
                    "forked_from": forked_from((rollout or "").removeprefix("\\\\?\\"))}
    return out


def same_dir(a, b):
    norm = lambda p: os.path.normcase(os.path.normpath((p or "").removeprefix("\\\\?\\"))) if p else None
    return bool(a and b) and norm(a) == norm(b)


def made_before(created, started):
    """True when a session already existed before the Herdr tab's program started: it was made
    elsewhere and reopened here (a minute's grace for clocks and slow starts)."""
    return bool(created and started and created < started - 60_000)


def forked_from(rollout):
    """The thread a Codex thread was forked from, from its rollout's first record."""
    try:
        with open(rollout, encoding="utf-8") as f:
            return (json.loads(f.readline()).get("payload") or {}).get("forked_from_id")
    except (OSError, ValueError, AttributeError):
        return None


UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def forked_ref(kind, argv):
    """The session a tab's command forks: `claude --resume X --fork-session`, `codex fork X`.
    The command may come as one string (`cmd /c "codex.cmd fork X ..."`), so it is read as a line."""
    line = " ".join(str(a) for a in argv or [])
    if kind == "claude":
        if "--fork-session" not in line:
            return None
        at = re.search(r"(?:--resume|(?<!\S)-r)(?:=|\s+)", line)
        found = at and UUID.search(line, at.end())  # the id, or a transcript path ending in it
        return found.group(0) if found else None
    found = re.search(r"(?<![\w-])fork\s+['\"]?(" + UUID.pattern + ")", line)
    return found.group(1) if found else None


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def pane_roles(terms, reg, keys):
    """Which pane of its tab each open session (`keys`) is in. The tab's oldest terminal is the one
    it was opened with (its main pane); a later one is a pane added beside it (a split). Kept in
    the registry, so a closed tab's sessions still say so; "beside" names the main pane's session."""
    first = {}
    for t in terms:
        tab = (t.get("labels") or {}).get("herdr.tab")
        if tab and (tab not in first or (t.get("created_ms") or 0) < (first[tab].get("created_ms") or 0)):
            first[tab] = t
    at = {reg[k]["terminal"]: k for k in keys}
    for k in keys:
        e = reg[k]
        main_t = first.get(e.get("tab"))
        e["pane"] = bool(main_t) and main_t["address"] != e["terminal"]
        e["beside"] = at.get(main_t["address"]) if e["pane"] else None


def address_order(address):
    """Herdr numbers terminals in base 36 as it makes them (t17s, t17t, …, t1c9)."""
    try:
        return int(address[1:], 36)
    except (TypeError, ValueError):
        return 1 << 62


def backfill_panes(terms, reg):
    """Sessions seen before pane_roles existed get their role once, from what is known of their tab:
    its terminals still in Herdr (their creation times), or else the oldest terminal among the
    tab's sessions here (a tab opened with a plain shell then looks as if its first agent was the
    main one). "beside" is the main terminal's session nearest in time."""
    oldest = {}
    for t in terms:
        tab = (t.get("labels") or {}).get("herdr.tab")
        if tab and (tab not in oldest or (t.get("created_ms") or 0) < (oldest[tab].get("created_ms") or 0)):
            oldest[tab] = t
    by_tab = {}
    for k, e in reg.items():
        if e.get("tab") and e.get("terminal"):
            by_tab.setdefault(e["tab"], []).append(k)
    for tab, keys in by_tab.items():
        todo = [k for k in keys if "pane" not in reg[k]]
        if not todo:
            continue
        main = oldest[tab]["address"] if tab in oldest else min((reg[k]["terminal"] for k in keys), key=address_order)
        in_main = [k for k in keys if reg[k]["terminal"] == main]
        for k in todo:
            e = reg[k]
            e["pane"] = e["terminal"] != main
            near = sorted(in_main, key=lambda m: abs((reg[m].get("last_seen") or 0) - (e.get("last_seen") or 0)))
            e["beside"] = near[0] if e["pane"] and near else None


TOGETHER = 300_000  # panes last seen this close to their main session were still open with it


def with_panes(rows):
    """Each main session's "with_panes": the panes added beside it that were still open when it was
    last seen (so closed with its tab, not earlier), one per pane terminal (the one seen last), in
    the order the panes were made. The panel opens them with it."""
    by_key = {r["key"]: r for r in rows}
    found = {}
    for r in rows:
        m = by_key.get(r.get("beside")) if r.get("pane") else None
        if not m or m.get("pane") or m is r:
            continue
        end = m.get("last_seen") or 0
        if (r.get("last_seen") or 0) >= end - TOGETHER and (r.get("first_seen") or 0) <= end + TOGETHER:
            found.setdefault(m["key"], {}).setdefault(r.get("terminal"), []).append(r)
    for key, terms in found.items():
        picks = [max(rs, key=lambda x: (x.get("last_seen") or 0, x.get("last") or 0)) for rs in terms.values()]
        picks.sort(key=lambda x: address_order(x.get("terminal")))
        by_key[key]["with_panes"] = [x["key"] for x in picks]


# ---------- the registry ---------------------------------------------------------------------

def load_registry():
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("sessions", {}) if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_registry(sessions):
    os.makedirs(STORE, exist_ok=True)
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "sessions": sessions}, f, ensure_ascii=False)
    os.replace(tmp, REGISTRY)


def main():
    claudes, codexes = claude_accounts(), codex_accounts()
    reg = load_registry()
    current = set()
    terms = herdr_terminals()
    if terms:
        procs = processes()
        under = {}  # pid -> terminal info
        for t in terms:
            for pid in descendants(t.get("pid") or 0, procs):
                under[pid] = t

        # One entry per session or thread, whichever account opens it; the first one owns it.
        def note(key, base, t):
            e = reg.get(key) or {**base, "first_seen": NOW}
            e["opened_with"] = base["account"]
            labels = t.get("labels") or {}
            title = (t.get("title") or "").strip()
            e.update({"terminal": t["address"], "space": labels.get("herdr.space"), "tab": labels.get("herdr.tab"),
                      "where": labels.get("where") or "", "last_seen": NOW})
            # the command the tab runs now, which names a forked session's parent
            if "launch" not in e:
                e["launch"] = [str(a) for a in ((t.get("foreground") or {}).get("argv") or [])][:40]
            if title and title.lower() not in ("claude code", "codex", "powershell", "windows powershell"):
                e["term_title"] = title
            reg[key] = e
            current.add(key)

        # Claude: the session file its process writes
        for pid, t in under.items():
            if procs[pid][1] != "claude.exe":
                continue
            for a in claudes:
                p = os.path.join(a["config"], "sessions", f"{pid}.json")
                if not os.path.isfile(p):
                    continue
                try:
                    s = json.load(open(p, encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if s.get("kind") != "interactive" or not s.get("sessionId"):
                    continue
                note(f"claude:{s['sessionId']}", {"kind": "claude", "account": a["name"], "id": s["sessionId"],
                                                              "cwd": s.get("cwd"), "started": s.get("startedAt")}, t)
        # Codex: the thread locks its process holds (codex --no-daemon)
        tuis = {}  # terminal address -> (terminal, its codex.exe)
        for pid, t in under.items():
            if procs[pid][1] == "codex.exe":
                tuis.setdefault(t["address"], (t, pid))
        if tuis:
            claimed, by_daemon = set(), {}
            for a in codexes:
                d = os.path.join(a["home"], "thread-writer-locks")
                for lock in glob.glob(os.path.join(d, "*.lock")):
                    tid = os.path.basename(lock)[:-5]
                    if tid.startswith(".") or not held(lock):
                        continue
                    who = holders(lock)
                    mine = next((pid for pid in who if pid in under and procs.get(pid, (0, ""))[1] == "codex.exe"), None)
                    if mine:
                        note(f"codex:{tid}", {"kind": "codex", "account": a["name"], "id": tid,
                                              "started": started_ms(mine)}, under[mine])
                        claimed.add(under[mine]["address"])
                    elif any(procs.get(pid, (0, ""))[1] == "codex.exe" for pid in who):
                        by_daemon.setdefault(a["name"], (a, []))[1].append(tid)
            # Codex on the shared daemon (its default lately): the daemon holds the lock, not the
            # tab's process. A thread the TUI made (codex-tui) in the tab's folder is the tab's when
            # it was there last time, the tab's title names it ("<thread> | <folder>"), or it was
            # made after the tab's Codex started; the closest pairs win, one thread per tab.
            rest = {addr: v for addr, v in tuis.items() if addr not in claimed}
            pairs = []
            for name, (a, ids) in by_daemon.items() if rest else ():
                for tid, th in codex_threads(a["home"], ids).items():
                    if th["archived"] or f"codex:{tid}" in current:
                        continue
                    before = reg.get(f"codex:{tid}") or {}
                    for addr, (t, pid) in rest.items():
                        if not same_dir((t.get("foreground") or {}).get("cwd") or t.get("cwd"), th["cwd"]):
                            continue
                        # a copy keeps its original's maker (an app thread's copy says "Codex Desktop"),
                        # but the tab that made it ran `codex fork <original>`
                        forked_here = bool(th["forked_from"]) and forked_ref("codex", (t.get("foreground") or {}).get("argv")) == th["forked_from"]
                        if th["originator"] != "codex-tui" and not forked_here:
                            continue
                        start = started_ms(pid)
                        named = (t.get("title") or "").split(" | ")[0].strip()
                        after = bool(th["created"] and start and th["created"] >= start)
                        score = (4 if forked_here and after else 0) \
                            + (3 if before.get("terminal") == addr and NOW - (before.get("last_seen") or 0) < 300_000 else 0) \
                            + (2 if named and named == th["title"] else 0) + (1 if after else 0)
                        if score:
                            gap = th["created"] - start if after else 1 << 62
                            pairs.append((-score, gap, addr, tid, a, start))
            used = set()
            for _, _, addr, tid, a, start in sorted(pairs):
                if addr in used or f"codex:{tid}" in current:
                    continue
                note(f"codex:{tid}", {"kind": "codex", "account": a["name"], "id": tid, "started": start, "daemon": True}, rest[addr][0])
                used.add(addr)
        pane_roles(terms, reg, current)
    backfill_panes(terms, reg)

    # Facts for the list: titles, folders, last activity, how to resume.
    cl = {a["name"]: a for a in claudes}
    cx = {a["name"]: a for a in codexes}
    by_home = {}
    for key, e in reg.items():
        if e.get("kind") == "codex" and e.get("account") in cx:
            by_home.setdefault(e["account"], set()).add(e["id"])
    threads = {name: codex_threads(cx[name]["home"], ids) for name, ids in by_home.items()}

    def transcript(sid, first=None):
        """A Claude session's transcript: its own account's folder first, then the others."""
        order = [cl[first]] if first in cl else []
        for a in order + [a for a in claudes if a not in order]:
            hits = glob.glob(os.path.join(a["config"], "projects", "*", f"{sid}.jsonl"))
            if hits:
                return hits[0]
        return None

    # What the Claude panel lists (the desktop app's sessions and the handover pairs).
    claude_panel = read_json(os.path.join(STORE, "claude-list.json"), {}).get("sessions", [])
    panel_claude = {s.get("cli") for s in claude_panel}
    panel_titles = {f"claude:{s.get('cli')}": s.get("title") for s in claude_panel}
    panel_titles.update({f"codex:{s.get('id')}": s.get("title") for s in read_json(os.path.join(STORE, "codex-list.json"), {}).get("threads", [])})

    def root_of(kind, ref):
        """Where a forked session's parent belongs."""
        p = reg.get(f"{kind}:{ref}")
        if p and p.get("root"):
            return p["root"]
        if kind == "codex":
            return "desktop"  # a thread Herdr didn't start is the Codex panel's
        if ref in panel_claude:
            return "desktop"
        path = transcript(ref)
        try:
            origin = claude_facts(path).get("origin") if path else None
        except OSError:
            origin = None
        return "desktop" if origin not in (None, "cli") else "herdr"

    def title_of(key):
        p = reg.get(key) or {}
        return (p.get("facts") or {}).get("title") or p.get("title") or panel_titles.get(key) or p.get("term_title") or ""

    out, derived, drop = [], [], []
    for key, e in reg.items():
        row = {"key": key, "kind": e.get("kind"), "account": e.get("account"), "id": e.get("id"),
               "terminal": e.get("terminal"), "where": e.get("where"), "current": key in current,
               "first_seen": e.get("first_seen"), "last_seen": e.get("last_seen"), "opened_with": e.get("opened_with")}
        if e["kind"] == "claude":
            path = e.get("path")
            if not path or not os.path.isfile(path):
                # a session opened with another account by its path stays in its own folder
                path = transcript(e["id"], e.get("account"))
                e["path"] = path
            if not path:
                if key not in current and NOW - (e.get("last_seen") or 0) > 3600_000:
                    drop.append(key)
                continue
            st = os.stat(path)
            stamp = f"{st.st_mtime_ns}-{st.st_size}"
            if e.get("stamp") != stamp:
                try:
                    e["facts"] = claude_facts(path)
                except OSError:
                    e["facts"] = {}
                e["stamp"] = stamp
            f = e.get("facts") or {}
            # A copy made in the tab (--fork-session) may start with its original's records, so
            # the tab's command decides that first. A desktop app session reopened in a Herdr tab
            # is the Claude panel's own entry.
            ref = forked_ref("claude", e.get("launch"))
            forked_here = bool(ref) and ref != e["id"]
            own = not forked_here and f.get("origin") not in (None, "cli")
            if not e.get("root"):
                if forked_here:
                    e["parent"], e["root"] = f"claude:{ref}", root_of("claude", ref)
                elif own:
                    e["root"] = "desktop"
                elif made_before(f.get("created"), e.get("started")):
                    e["root"] = "outside"
                else:
                    e["root"] = "herdr"
            row.update({"title": f.get("title") or e.get("term_title") or f.get("first") or "", "cwd": e.get("cwd"),
                        "path": path, "perm": f.get("perm"), "last": int(st.st_mtime * 1000)})
        else:
            th = threads.get(e["account"], {}).get(e["id"])
            if not th:
                if key not in current and NOW - (e.get("last_seen") or 0) > 3600_000:
                    drop.append(key)
                continue
            if not th["user"] or th["archived"]:
                continue
            # A copy keeps its original's maker, so a fork made here (the tab ran `codex fork`, or the
            # TUI made it) is decided first. A Codex app thread reopened in a Herdr tab is the Codex
            # panel's own entry. The TUI marks its threads codex-tui (source "vscode" when it ran on
            # the daemon, "cli" without it).
            tui = th["cli"] or th["originator"] == "codex-tui"
            ref = th["forked_from"] or forked_ref("codex", e.get("launch"))
            forked_here = bool(ref) and ref != e["id"] and (tui or forked_ref("codex", e.get("launch")) == ref)
            own = not forked_here and not tui
            if not e.get("root"):
                if forked_here:
                    e["parent"], e["root"] = f"codex:{ref}", root_of("codex", ref)
                elif own:
                    e["root"] = "desktop"
                elif made_before(th["created"], e.get("started")):
                    e["root"] = "outside"
                else:
                    e["root"] = "herdr"
            e["title"] = th["title"]
            row.update({"title": th["title"] or e.get("term_title") or "", "cwd": th["cwd"], "last": th["last"] or e.get("last_seen"),
                        "model": th["model"], "effort": th["effort"], "approval": th["approval"], "sandbox": th["sandbox"],
                        "originator": th["originator"], "home": cx[e["account"]]["home"] if e["account"] in cx else None})
        row["folder"] = bool(row.get("cwd")) and os.path.isdir(row["cwd"])
        if e.get("pane"):
            row.update({"pane": True, "beside": e.get("beside"), "beside_title": title_of(e["beside"]) if e.get("beside") else ""})
        row["root"] = root = e.get("root")
        if root == "herdr":
            out.append(row)
        elif root == "outside":
            # Made elsewhere, reopened in a Herdr tab. The Codex panel lists codex's own threads
            # already; other accounts' threads and CLI Claude sessions join their panel from here.
            if e["kind"] == "claude" or not cx.get(e["account"], {}).get("main"):
                row["how"] = "outside"
                derived.append(row)
        elif not own:
            # forked from an app session: the Claude or Codex panel lists it
            row["how"] = "fork"
            row["parent"] = e.get("parent")
            row["parent_title"] = title_of(e.get("parent")) if e.get("parent") else ""
            derived.append(row)
    with_panes(out)
    for key in drop:
        reg.pop(key, None)
    save_registry(reg)
    out.sort(key=lambda r: r.get("last") or 0, reverse=True)
    herdr_ids = {"claude": [r["id"] for r in out if r["kind"] == "claude"], "codex": [r["id"] for r in out if r["kind"] == "codex"]}
    write_atomic(os.path.join(STORE, "derived.json"), json.dumps({"updated": NOW, "derived": derived, "herdr": herdr_ids}, ensure_ascii=False))
    strip = lambda accts, k: [{x: a[x] for x in ("name", "cmd", "main", k)} for a in accts]
    text = json.dumps({"accounts": {"claude": strip(claudes, "config"), "codex": strip(codexes, "home")},
                       "sessions": out}, ensure_ascii=False)
    # The session-search window (Ctrl+Shift+S) reads the last list from here.
    write_atomic(os.path.join(STORE, "herdr-list.json"), text)
    sys.stdout.write(text)


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


if __name__ == "__main__":
    main()
